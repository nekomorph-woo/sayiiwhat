use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, RwLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{watch, Mutex as TokioMutex},
};
use uuid::Uuid;

#[derive(Debug)]
struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "用户已中止任务")
    }
}

impl std::error::Error for Cancelled {}

fn is_cancelled(err: &anyhow::Error) -> bool {
    err.downcast_ref::<Cancelled>().is_some()
}

struct RunningTaskHandle {
    cancel: watch::Sender<bool>,
}

struct AppState {
    archive_root: RwLock<PathBuf>,
    running: TokioMutex<HashMap<String, Arc<RunningTaskHandle>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            archive_root: RwLock::new(PathBuf::new()),
            running: TokioMutex::new(HashMap::new()),
        }
    }
}

async fn check_cancelled(handle: &Arc<RunningTaskHandle>) -> Result<()> {
    if *handle.cancel.borrow() {
        return Err(anyhow::Error::new(Cancelled));
    }
    Ok(())
}

const DEFAULT_TARGET_LANGUAGE: &str = "简体中文";
const DEFAULT_SYSTEM_PROMPT: &str = "你是专业影视字幕译审。请把 Whisper 识别出的字幕翻译/润色为用户指定的目标语言；结合上下文修正明显断句、大小写和轻微识别错误。译文要口语、简短、适合屏幕阅读，不添加解释。";
const DEFAULT_USER_TEMPLATE: &str = "请处理下面字幕块。原文可能是 Whisper 支持的任意语言，请自动判断源语言，并翻译/润色为目标语言：{targetLanguage}。\n\n你需要同时做两件事：\n1. 结合上下文修正 Whisper 可能造成的半句、断句、大小写和轻微识别错误。\n2. 在不改变整体时间范围的前提下，生成更自然的最终目标语言字幕时间轴；可以合并相邻半句，也可以把过长译文拆成多条。\n\n时间轴规则：\n- 每条 cue 的 start/end 使用数字秒，必须位于输入字幕块的时间范围内。\n- cue 必须按时间递增，不能重叠。\n- 单条 cue 建议 1.2–6.5 秒，尽量不要超过 7 秒。\n- 不要让一句完整长句长时间停留在屏幕上；长句要拆成自然的 2–3 条短字幕。\n- 每条字幕应简短、口语、适合屏幕阅读。\n\n只返回严格 JSON，不要 Markdown，不要解释。格式：\n{\"cues\":[{\"source\":[1,2],\"start\":12.34,\"end\":15.67,\"text\":\"目标语言字幕\"}]}\n\n输入字幕：\n{items}";
const BUNDLED_VAD_MODEL: &str = "ggml-silero-v6.2.0.bin";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub model_path: String,
    pub language: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub whisper_path: String,
    pub auto_segment: bool,
    pub segment_threshold_minutes: u32,
    pub segment_minutes: u32,
    pub overlap_seconds: u32,
    pub translation: Vec<TranslationConfig>,
    #[serde(default)]
    pub debug: DebugConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfig {
    pub enabled: bool,
    pub archive_root: String,
}

impl Default for DebugConfig {
    fn default() -> Self {
        Self { enabled: false, archive_root: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_config_name")]
    pub name: String,
    pub enabled: bool,
    pub provider: TranslationProvider,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default = "default_target_language")]
    pub target_language: String,
    pub temperature: f32,
    pub timeout_seconds: u64,
    pub batch_size: usize,
    pub system_prompt: String,
    pub user_template: String,
}

fn default_config_name() -> String {
    "默认".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TranslationProvider {
    Mock,
    OpenAiCompatible,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            model_path: String::new(),
            language: "auto".into(),
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            whisper_path: String::new(),
            auto_segment: true,
            segment_threshold_minutes: 30,
            segment_minutes: 15,
            overlap_seconds: 3,
            translation: vec![TranslationConfig::default()],
            debug: DebugConfig::default(),
        }
    }
}

impl Default for TranslationConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "默认".into(),
            enabled: true,
            provider: TranslationProvider::Mock,
            base_url: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            model: "gpt-4.1-mini".into(),
            target_language: DEFAULT_TARGET_LANGUAGE.into(),
            temperature: 0.2,
            timeout_seconds: 120,
            batch_size: 40,
            system_prompt: DEFAULT_SYSTEM_PROMPT.into(),
            user_template: DEFAULT_USER_TEMPLATE.into(),
        }
    }
}

fn default_target_language() -> String {
    DEFAULT_TARGET_LANGUAGE.into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessVideoRequest {
    pub id: String,
    pub video_path: String,
    pub config: AppConfig,
    pub debug_segment_seconds: Option<u32>,
    pub vad_enabled: bool,
    pub vad_threshold: f32,
    #[serde(default)]
    pub translation_config_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessVideoResult {
    pub id: String,
    pub video_path: String,
    pub output_path: String,
    pub subtitle_count: usize,
    pub used_segments: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub level: String,
    pub message: String,
    pub progress: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub ffmpeg: ToolCheck,
    pub ffprobe: ToolCheck,
    pub whisper: ToolCheck,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    pub ok: bool,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone)]
struct Segment {
    index: usize,
    start: f64,
    end: Option<f64>,
    wav_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleEntry {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub translated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedTaskMeta {
    pub id: String,
    pub video_path: String,
    pub output_path: String,
    pub status: String,
    pub vad_enabled: bool,
    pub vad_threshold: f32,
    pub translation_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub translation_config_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub translation_config_name: Option<String>,
    pub subtitle_count: usize,
    pub used_segments: usize,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleRecord {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub translated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleRecords {
    pub entries: Vec<SubtitleRecord>,
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let debug = read_bootstrap_debug(&app.handle());
            let archive_root = effective_archive_root(&debug).unwrap_or_else(|_| PathBuf::from("."));
            app.manage(AppState {
                archive_root: RwLock::new(archive_root),
                running: TokioMutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            check_tools,
            process_video,
            test_translation,
            fetch_translation_models,
            list_archived_tasks,
            read_task_subtitles,
            save_task_subtitles,
            delete_archived_tasks,
            open_in_folder,
            open_url,
            read_settings_file,
            archive_overview,
            cancel_task
        ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running sayiiwhat");
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    let debug = read_bootstrap_debug(&app);
    let archive_root = effective_archive_root(&debug).map_err(to_string)?;
    let settings_path = settings_path_under(&archive_root);
    let mut config = if settings_path.is_file() {
        let text = fs::read_to_string(&settings_path).map_err(to_string)?;
        let mut value: Value = serde_json::from_str(&text).map_err(to_string)?;
        if let Some(obj) = value.as_object_mut() {
            obj.remove("debug");
            // 旧版 translation 是单一对象 → 包成单元素数组；补 id + name="默认"
            if let Some(translation) = obj.remove("translation") {
                let array = match translation {
                    Value::Array(arr) => arr,
                    Value::Object(mut map) => {
                        if !map.contains_key("id") {
                            map.insert("id".into(), Value::String(Uuid::new_v4().to_string()));
                        }
                        map.entry("name").or_insert_with(|| Value::String("默认".into()));
                        vec![Value::Object(map)]
                    }
                    other => vec![other],
                };
                obj.insert("translation".into(), Value::Array(array));
            }
        }
        serde_json::from_value::<AppConfig>(value).unwrap_or_default()
    } else {
        AppConfig::default()
    };
    if config.translation.is_empty() {
        config.translation.push(TranslationConfig::default());
    }
    for t in config.translation.iter_mut() {
        if t.id.trim().is_empty() {
            t.id = Uuid::new_v4().to_string();
        }
        if t.name.trim().is_empty() {
            t.name = "默认".into();
        }
        if !t.user_template.contains("\"cues\"") || !t.user_template.contains("{targetLanguage}") {
            t.user_template = DEFAULT_USER_TEMPLATE.into();
        }
        if t.target_language.trim().is_empty() {
            t.target_language = DEFAULT_TARGET_LANGUAGE.into();
        }
        if t.system_prompt.trim().is_empty() {
            t.system_prompt = DEFAULT_SYSTEM_PROMPT.into();
        }
    }
    config.debug = debug;
    Ok(config)
}

/// Fields the user fills in by hand (secrets + tool paths). These are the
/// fields whose `AppConfig`/`defaultConfig` default is the empty string, so an
/// accidental full-width `save_config` with an un-hydrated (default) config can
/// silently wipe real values. We never let an empty incoming value overwrite a
/// non-empty on-disk value for these fields — see `save_config`.
const PROTECTED_TOP_FIELDS: &[&str] = &["modelPath", "ffmpegPath", "ffprobePath", "whisperPath"];
const PROTECTED_TRANSLATION_FIELDS: &[&str] = &["apiKey", "baseUrl", "model"];

fn preserve_non_empty(target: &mut serde_json::Map<String, Value>, source: &serde_json::Map<String, Value>, key: &str) {
    let incoming_empty = match target.get(key) {
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(Value::Null) | None => true,
        _ => false,
    };
    if !incoming_empty {
        return;
    }
    let disk_has_value = matches!(source.get(key), Some(Value::String(s)) if !s.trim().is_empty());
    if disk_has_value {
        if let Some(v) = source.get(key) {
            target.insert(key.to_string(), v.clone());
        }
    }
}

/// Merge `disk` into `incoming` so that protected (user-supplied) fields are
/// never blanked out by an empty incoming value. Only the listed fields are
/// touched; everything else follows the incoming (latest) value.
fn merge_protected_fields(incoming: &mut Value, disk: &Value) {
    let Some(in_obj) = incoming.as_object_mut() else { return };
    let Some(disk_obj) = disk.as_object() else { return };

    for key in PROTECTED_TOP_FIELDS {
        preserve_non_empty(in_obj, disk_obj, key);
    }

    // translation 现在是数组：按 id 匹配每对项，单独保护 apiKey/baseUrl/model
    if let Some(Value::Array(in_arr)) = in_obj.get_mut("translation") {
        if let Some(Value::Array(disk_arr)) = disk_obj.get("translation") {
            for in_item in in_arr.iter_mut() {
                let Some(in_t) = in_item.as_object_mut() else { continue };
                let in_id = in_t.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if in_id.is_empty() {
                    continue;
                }
                let Some(disk_t) = disk_arr.iter().find_map(|d| {
                    let dobj = d.as_object()?;
                    let did = dobj.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    (did == in_id).then_some(dobj)
                }) else { continue };
                for key in PROTECTED_TRANSLATION_FIELDS {
                    preserve_non_empty(in_t, disk_t, key);
                }
            }
        }
    }
}

#[tauri::command]
fn save_config(app: AppHandle, state: State<'_, AppState>, config: AppConfig) -> Result<(), String> {
    let bootstrap_path = bootstrap_config_path(&app).map_err(to_string)?;
    if let Some(parent) = bootstrap_path.parent() {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    let bootstrap = serde_json::json!({ "debug": config.debug });
    fs::write(&bootstrap_path, serde_json::to_string_pretty(&bootstrap).map_err(to_string)?).map_err(to_string)?;

    let archive_root = effective_archive_root(&config.debug).map_err(to_string)?;
    fs::create_dir_all(&archive_root).map_err(to_string)?;
    let settings_path = settings_path_under(&archive_root);
    let mut value = serde_json::to_value(&config).map_err(to_string)?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("debug");
    }
    // Never let an empty incoming secret/path wipe a real on-disk value. This is
    // the guard that prevents the "config disappears after enabling debug" bug,
    // where the frontend can briefly auto-save an un-hydrated default config.
    if let Ok(existing_text) = fs::read_to_string(&settings_path) {
        if let Ok(existing) = serde_json::from_str::<Value>(&existing_text) {
            merge_protected_fields(&mut value, &existing);
        }
    }
    fs::write(&settings_path, serde_json::to_string_pretty(&value).map_err(to_string)?).map_err(to_string)?;

    *state.archive_root.write().unwrap() = archive_root;
    Ok(())
}

#[tauri::command]
async fn check_tools(app: AppHandle, config: AppConfig) -> Result<ToolStatus, String> {
    Ok(ToolStatus {
        ffmpeg: check_tool(resolve_binary(&app, &config.ffmpeg_path, "ffmpeg", "ffmpeg.exe").map_err(to_string)?).await,
        ffprobe: check_tool(resolve_binary(&app, &config.ffprobe_path, "ffprobe", "ffprobe.exe").map_err(to_string)?).await,
        whisper: check_tool(resolve_binary(&app, &config.whisper_path, "whisper-cli", "whisper-cli.exe").map_err(to_string)?).await,
    })
}

#[tauri::command]
async fn process_video(app: AppHandle, state: State<'_, AppState>, request: ProcessVideoRequest) -> Result<ProcessVideoResult, String> {
    let id = request.id.clone();
    let video_path = request.video_path.clone();
    let vad_enabled = request.vad_enabled;
    let vad_threshold = request.vad_threshold;
    let active_translation = request.translation_config_id.as_deref()
        .and_then(|rid| request.config.translation.iter().find(|t| t.id == rid));
    let translation_enabled = active_translation.map(|t| t.enabled).unwrap_or(false);
    let translation_config_id = active_translation.map(|t| t.id.clone());
    let translation_config_name = active_translation.map(|t| t.name.clone());
    let created_at = chrono::Utc::now().to_rfc3339();
    let archive_root = archive_root_from_state(&state);
    let _ = write_task_meta_at(&archive_root, &ArchivedTaskMeta {
        id: id.clone(),
        video_path: video_path.clone(),
        output_path: String::new(),
        status: "running".into(),
        vad_enabled,
        vad_threshold,
        translation_enabled,
        translation_config_id: translation_config_id.clone(),
        translation_config_name: translation_config_name.clone(),
        subtitle_count: 0,
        used_segments: 0,
        error: None,
        created_at: created_at.clone(),
        finished_at: None,
    });

    let (cancel_tx, _cancel_rx) = watch::channel(false);
    let handle = Arc::new(RunningTaskHandle { cancel: cancel_tx });
    {
        let mut map = state.running.lock().await;
        map.insert(id.clone(), handle.clone());
    }

    let result = process_video_inner(app, archive_root.clone(), request, handle.clone()).await;

    {
        let mut map = state.running.lock().await;
        map.remove(&id);
    }

    match &result {
        Ok(r) => {
            let _ = write_task_meta_at(&archive_root, &ArchivedTaskMeta {
                id: r.id.clone(),
                video_path: r.video_path.clone(),
                output_path: r.output_path.clone(),
                status: "done".into(),
                vad_enabled,
                vad_threshold,
                translation_enabled,
                translation_config_id: translation_config_id.clone(),
                translation_config_name: translation_config_name.clone(),
                subtitle_count: r.subtitle_count,
                used_segments: r.used_segments,
                error: None,
                created_at,
                finished_at: Some(chrono::Utc::now().to_rfc3339()),
            });
        }
        Err(error) if is_cancelled(error) => {
            let _ = write_task_meta_at(&archive_root, &ArchivedTaskMeta {
                id: id.clone(),
                video_path: video_path.clone(),
                output_path: String::new(),
                status: "cancelled".into(),
                vad_enabled,
                vad_threshold,
                translation_enabled,
                translation_config_id: translation_config_id.clone(),
                translation_config_name: translation_config_name.clone(),
                subtitle_count: 0,
                used_segments: 0,
                error: Some("用户已中止".into()),
                created_at,
                finished_at: Some(chrono::Utc::now().to_rfc3339()),
            });
        }
        Err(error) => {
            let message = error.to_string();
            let _ = write_task_meta_at(&archive_root, &ArchivedTaskMeta {
                id: id.clone(),
                video_path: video_path.clone(),
                output_path: String::new(),
                status: "failed".into(),
                vad_enabled,
                vad_threshold,
                translation_enabled,
                translation_config_id: translation_config_id.clone(),
                translation_config_name: translation_config_name.clone(),
                subtitle_count: 0,
                used_segments: 0,
                error: Some(message),
                created_at,
                finished_at: Some(chrono::Utc::now().to_rfc3339()),
            });
        }
    }
    result.map_err(|e| e.to_string())
}

async fn process_video_inner(app: AppHandle, archive_root: PathBuf, request: ProcessVideoRequest, handle: Arc<RunningTaskHandle>) -> Result<ProcessVideoResult> {
    let id = request.id.clone();
    let video_path = PathBuf::from(&request.video_path);
    if !video_path.is_file() {
        return Err(anyhow!("视频文件不存在：{}", request.video_path));
    }
    if request.config.model_path.trim().is_empty() {
        return Err(anyhow!("请先在模型设置中选择 whisper.cpp 模型文件"));
    }
    let model_path = PathBuf::from(&request.config.model_path);
    if !model_path.is_file() {
        return Err(anyhow!("模型文件不存在：{}", model_path.display()));
    }

    let ffmpeg = resolve_binary(&app, &request.config.ffmpeg_path, "ffmpeg", "ffmpeg.exe")?;
    let ffprobe = resolve_binary(&app, &request.config.ffprobe_path, "ffprobe", "ffprobe.exe")?;
    let whisper = resolve_binary(&app, &request.config.whisper_path, "whisper-cli", "whisper-cli.exe")?;
    let vad_model = if request.vad_enabled {
        let model = resolve_bundled_vad_model(&app)?;
        emit(&app, &id, "info", &format!("启用 VAD 人声检测，阈值 {:.2}", request.vad_threshold), 0.03);
        Some(model)
    } else {
        None
    };
    let vad_threshold = request.vad_threshold.clamp(0.05, 0.95);

    emit(&app, &id, "info", "准备临时工作目录", 0.02);
    let temp = tempfile::tempdir().context("无法创建临时目录")?;
    let source_wav = temp.path().join("source.wav");

    emit(&app, &id, "info", "用 ffmpeg 抽取 16kHz 单声道音频", 0.06);
    run_and_stream(
        &app,
        &id,
        Command::new(&ffmpeg)
            .arg("-y")
            .arg("-i")
            .arg(&video_path)
            .arg("-vn")
            .arg("-af")
            .arg("aresample=async=1")
            .arg("-ar")
            .arg("16000")
            .arg("-ac")
            .arg("1")
            .arg("-c:a")
            .arg("pcm_s16le")
            .arg(&source_wav),
        "ffmpeg",
        &handle,
    ).await?;

    let duration = probe_duration(&ffprobe, &video_path).await.unwrap_or(0.0);
    let segment_seconds = request
        .debug_segment_seconds
        .map(|v| v as f64)
        .unwrap_or((request.config.segment_minutes.max(1) * 60) as f64);
    let threshold_seconds = (request.config.segment_threshold_minutes.max(1) * 60) as f64;
    let overlap = request.config.overlap_seconds as f64;
    let should_segment = request.config.auto_segment && duration > threshold_seconds;
    let segments = if should_segment {
        emit(&app, &id, "info", &format!("视频约 {:.1} 分钟，进入分段模式", duration / 60.0), 0.12);
        cut_segments(&app, &id, &ffmpeg, &source_wav, temp.path(), duration, segment_seconds, overlap, &handle).await?
    } else {
        emit(&app, &id, "info", "视频较短，整段识别", 0.12);
        vec![Segment { index: 0, start: 0.0, end: None, wav_path: source_wav.clone() }]
    };

    let mut entries = Vec::new();
    for (idx, segment) in segments.iter().enumerate() {
        check_cancelled(&handle).await?;
        let base_progress = 0.18 + (idx as f32 / segments.len() as f32) * 0.48;
        emit(&app, &id, "info", &format!("识别第 {}/{} 段", idx + 1, segments.len()), base_progress);
        let mut segment_entries = transcribe_segment(
            &app,
            &id,
            &whisper,
            &model_path,
            &request.config.language,
            segment,
            temp.path(),
            vad_model.as_deref(),
            vad_threshold,
            &handle,
        ).await?;
        entries.append(&mut segment_entries);
    }

    check_cancelled(&handle).await?;
    entries.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    let mut entries = dedupe_and_normalize(entries);
    emit(&app, &id, "info", &format!("识别完成，共 {} 条字幕", entries.len()), 0.68);

    check_cancelled(&handle).await?;
    entries = polish_subtitle_timing(entries);
    emit(&app, &id, "info", "已应用字幕时间轴后处理", 0.70);

    check_cancelled(&handle).await?;
    let active_translation = request.translation_config_id.as_deref()
        .and_then(|rid| request.config.translation.iter().find(|t| t.id == rid));
    if let Some(active) = active_translation {
        if active.enabled {
            let mut cfg = active.clone();
            cfg.enabled = true;
            emit(&app, &id, "info", &format!("使用翻译配置：{}", cfg.name), 0.71);
            entries = translate_entries(&app, &id, &cfg, entries, &handle).await?;
        } else {
            emit(&app, &id, "info", "未启用翻译，保留原文字幕", 0.84);
        }
    } else if request.translation_config_id.is_some() {
        return Err(anyhow!("找不到翻译配置：{}", request.translation_config_id.as_deref().unwrap_or("")));
    } else {
        emit(&app, &id, "info", "未启用翻译，保留原文字幕", 0.84);
    }

    check_cancelled(&handle).await?;
    let output_path = video_path.with_extension("srt");
    emit(&app, &id, "info", &format!("写出外挂字幕：{}", output_path.display()), 0.94);
    write_srt(&output_path, &entries)?;
    let _ = write_task_subtitles_at(&archive_root, &id, &SubtitleRecords {
        entries: entries.iter().map(|e| SubtitleRecord {
            index: e.index,
            start: e.start,
            end: e.end,
            text: e.text.clone(),
            translated: e.translated.clone(),
        }).collect(),
    });
    emit(&app, &id, "success", "完成", 1.0);

    Ok(ProcessVideoResult {
        id,
        video_path: request.video_path,
        output_path: output_path.to_string_lossy().to_string(),
        subtitle_count: entries.len(),
        used_segments: segments.len(),
    })
}

fn resolve_binary(app: &AppHandle, configured: &str, unix_name: &str, windows_name: &str) -> Result<PathBuf> {
    if !configured.trim().is_empty() {
        return Ok(PathBuf::from(configured));
    }

    let resource_candidates = app.path().resource_dir().ok().into_iter().flat_map(|dir| {
        let platform_dir = if cfg!(target_os = "windows") { "windows" } else { "macos" };
        let executable = if cfg!(target_os = "windows") { windows_name } else { unix_name };
        vec![
            dir.join("resources").join("bin").join(platform_dir).join(executable),
            dir.join("bin").join(platform_dir).join(executable),
            dir.join("bin").join(executable),
        ]
    });
    for candidate in resource_candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Ok(PathBuf::from(if cfg!(target_os = "windows") { windows_name } else { unix_name }))
}

fn resolve_bundled_vad_model(app: &AppHandle) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join("models").join("vad").join(BUNDLED_VAD_MODEL));
        candidates.push(dir.join("models").join("vad").join(BUNDLED_VAD_MODEL));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("models").join("vad").join(BUNDLED_VAD_MODEL));
        candidates.push(cwd.join("resources").join("models").join("vad").join(BUNDLED_VAD_MODEL));
        candidates.push(cwd.join("apps").join("desktop").join("src-tauri").join("resources").join("models").join("vad").join(BUNDLED_VAD_MODEL));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err(anyhow!("内置 VAD 模型缺失：{BUNDLED_VAD_MODEL}"))
}

async fn check_tool(path: PathBuf) -> ToolCheck {
    let output = Command::new(&path).arg("-version").output().await;
    match output {
        Ok(out) if out.status.success() => ToolCheck {
            ok: true,
            path: path.to_string_lossy().to_string(),
            message: String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("可用").to_string(),
        },
        Ok(out) => ToolCheck {
            ok: false,
            path: path.to_string_lossy().to_string(),
            message: String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("不可用").to_string(),
        },
        Err(err) => ToolCheck {
            ok: false,
            path: path.to_string_lossy().to_string(),
            message: err.to_string(),
        },
    }
}

async fn probe_duration(ffprobe: &Path, video_path: &Path) -> Result<f64> {
    let output = Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(video_path)
        .output()
        .await?;
    if !output.status.success() {
        return Err(anyhow!("ffprobe 获取时长失败"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.trim().parse::<f64>()?)
}

async fn cut_segments(
    app: &AppHandle,
    id: &str,
    ffmpeg: &Path,
    source_wav: &Path,
    workdir: &Path,
    duration: f64,
    segment_seconds: f64,
    overlap: f64,
    handle: &Arc<RunningTaskHandle>,
) -> Result<Vec<Segment>> {
    let mut segments = Vec::new();
    let mut start = 0.0;
    let mut index = 0usize;
    while start < duration {
        let end = (start + segment_seconds + overlap).min(duration);
        let output = workdir.join(format!("segment-{index:03}.wav"));
        emit(app, id, "info", &format!("切分音频段 {}：{} → {}", index + 1, format_seconds(start), format_seconds(end)), 0.14);
        run_and_stream(
            app,
            id,
            Command::new(ffmpeg)
                .arg("-y")
                .arg("-ss")
                .arg(format!("{start:.3}"))
                .arg("-to")
                .arg(format!("{end:.3}"))
                .arg("-i")
                .arg(source_wav)
                .arg("-c")
                .arg("copy")
                .arg(&output),
            "ffmpeg-cut",
            handle,
        ).await?;
        segments.push(Segment { index, start, end: Some(end), wav_path: output });
        index += 1;
        start += segment_seconds;
    }
    Ok(segments)
}

async fn transcribe_segment(
    app: &AppHandle,
    id: &str,
    whisper: &Path,
    model_path: &Path,
    language: &str,
    segment: &Segment,
    workdir: &Path,
    vad_model: Option<&Path>,
    vad_threshold: f32,
    handle: &Arc<RunningTaskHandle>,
) -> Result<Vec<SubtitleEntry>> {
    let output_base = workdir.join(format!("whisper-{:03}", segment.index));
    let lang = if language.trim().is_empty() { "auto" } else { language.trim() };
    let mut command = Command::new(whisper);
    command
        .arg("-m")
        .arg(model_path)
        .arg("-l")
        .arg(lang)
        .arg("-oj")
        .arg("-of")
        .arg(&output_base)
        .arg("--no-prints")
        .arg("--print-progress");
    if let Some(vad_model) = vad_model {
        command
            .arg("--vad")
            .arg("--vad-model")
            .arg(vad_model)
            .arg("--vad-threshold")
            .arg(format!("{:.2}", vad_threshold));
    }
    command
        .arg("-f")
        .arg(&segment.wav_path);

    run_and_stream(
        app,
        id,
        &mut command,
        "whisper",
        handle,
    ).await?;

    let json_path = output_base.with_extension("json");
    let text = fs::read_to_string(&json_path)
        .with_context(|| format!("无法读取 whisper JSON：{}", json_path.display()))?;
    parse_whisper_json(&text, segment.start, segment.end)
}

pub fn parse_whisper_json(text: &str, offset_seconds: f64, segment_end: Option<f64>) -> Result<Vec<SubtitleEntry>> {
    let value: Value = serde_json::from_str(text)?;
    let list = value
        .get("transcription")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("whisper JSON 缺少 transcription 数组"))?;

    let mut entries = Vec::new();
    for item in list {
        let raw_text = item.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if raw_text.is_empty() {
            continue;
        }
        let timestamps = item.get("timestamps").unwrap_or(&Value::Null);
        let from = timestamps.get("from").and_then(Value::as_str).and_then(parse_timestamp).unwrap_or(0.0);
        let to = timestamps.get("to").and_then(Value::as_str).and_then(parse_timestamp).unwrap_or(from + 1.0);
        let start = offset_seconds + from;
        let mut end = offset_seconds + to;
        if let Some(max_end) = segment_end {
            end = end.min(max_end);
        }
        entries.push(SubtitleEntry {
            index: 0,
            start,
            end: end.max(start + 0.2),
            text: raw_text.to_string(),
            translated: None,
        });
    }
    Ok(entries)
}

fn parse_timestamp(input: &str) -> Option<f64> {
    let normalized = input.trim().replace(',', ".");
    let parts: Vec<_> = normalized.split(':').collect();
    match parts.as_slice() {
        [h, m, s] => Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?),
        [m, s] => Some(m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?),
        [s] => s.parse::<f64>().ok(),
        _ => None,
    }
}

pub fn dedupe_and_normalize(mut entries: Vec<SubtitleEntry>) -> Vec<SubtitleEntry> {
    entries.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<SubtitleEntry> = Vec::new();
    for mut entry in entries {
        let duplicate = out.last().map(|prev| {
            (entry.start - prev.start).abs() < 2.5 && normalized_text(&entry.text) == normalized_text(&prev.text)
        }).unwrap_or(false);
        if duplicate {
            continue;
        }
        if let Some(prev) = out.last_mut() {
            if entry.start < prev.end {
                prev.end = (entry.start - 0.05).max(prev.start + 0.2);
            }
        }
        entry.index = out.len() + 1;
        out.push(entry);
    }
    out
}

pub fn polish_subtitle_timing(entries: Vec<SubtitleEntry>) -> Vec<SubtitleEntry> {
    const MAX_DURATION: f64 = 7.0;
    const MIN_DURATION: f64 = 1.2;
    const GAP_BEFORE_NEXT: f64 = 0.12;
    const MAX_CHARS: usize = 56;

    let mut expanded = Vec::new();
    for entry in entries {
        let chunks = split_subtitle_text(&entry.text, MAX_CHARS);
        let duration = (entry.end - entry.start).max(MIN_DURATION);
        let target_count = if chunks.len() == 1 && duration > MAX_DURATION {
            1
        } else {
            chunks.len().max((duration / MAX_DURATION).ceil() as usize).max(1)
        };
        let chunks = rebalance_chunks(chunks, target_count, MAX_CHARS);

        if chunks.len() == 1 {
            let mut item = entry;
            item.end = (item.start + duration.min(MAX_DURATION).max(MIN_DURATION)).min(item.end.max(item.start + MIN_DURATION));
            expanded.push(item);
            continue;
        }

        let usable_span = duration.min(chunks.len() as f64 * MAX_DURATION).max(chunks.len() as f64 * MIN_DURATION);
        let weights = chunks.iter().map(|chunk| visual_len(chunk).max(1) as f64).collect::<Vec<_>>();
        let total_weight = weights.iter().sum::<f64>().max(1.0);
        let mut cursor = entry.start;
        for (idx, chunk) in chunks.iter().enumerate() {
            let share = (usable_span * (weights[idx] / total_weight)).clamp(MIN_DURATION, MAX_DURATION);
            let is_last = idx == chunks.len() - 1;
            let end = if is_last { (entry.start + usable_span).min(entry.end) } else { (cursor + share).min(entry.end) };
            expanded.push(SubtitleEntry {
                index: 0,
                start: cursor,
                end: end.max(cursor + MIN_DURATION).min(entry.end),
                text: chunk.trim().to_string(),
                translated: None,
            });
            cursor = expanded.last().map(|last| last.end + 0.04).unwrap_or(cursor);
            if cursor >= entry.end {
                break;
            }
        }
    }

    expanded.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    for i in 0..expanded.len() {
        if i + 1 < expanded.len() {
            let latest_end = (expanded[i + 1].start - GAP_BEFORE_NEXT).max(expanded[i].start + 0.25);
            if expanded[i].end > latest_end {
                expanded[i].end = latest_end;
            }
        }
        let max_end = expanded[i].start + MAX_DURATION;
        if expanded[i].end > max_end {
            expanded[i].end = max_end;
        }
        if expanded[i].end < expanded[i].start + MIN_DURATION {
            expanded[i].end = expanded[i].start + MIN_DURATION;
            if i + 1 < expanded.len() && expanded[i].end > expanded[i + 1].start - GAP_BEFORE_NEXT {
                expanded[i].end = (expanded[i + 1].start - GAP_BEFORE_NEXT).max(expanded[i].start + 0.25);
            }
        }
        expanded[i].index = i + 1;
    }
    expanded
}

fn split_subtitle_text(text: &str, max_chars: usize) -> Vec<String> {
    let text = text.trim();
    if visual_len(text) <= max_chars {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    for token in tokenize_subtitle_text(text) {
        let candidate = if current.is_empty() {
            token.clone()
        } else {
            join_pair(&current, &token)
        };
        if visual_len(&candidate) > max_chars && !current.is_empty() {
            chunks.push(current.trim().to_string());
            current = token;
        } else {
            current = candidate;
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    if chunks.is_empty() {
        vec![text.to_string()]
    } else {
        chunks
    }
}

fn rebalance_chunks(mut chunks: Vec<String>, target_count: usize, max_chars: usize) -> Vec<String> {
    while chunks.len() < target_count {
        let Some((idx, _)) = chunks.iter().enumerate().max_by_key(|(_, chunk)| visual_len(chunk)) else {
            break;
        };
        if visual_len(&chunks[idx]) < max_chars / 2 {
            break;
        }
        let chunk = chunks.remove(idx);
        let (left, right) = split_chunk_roughly(&chunk);
        if right.trim().is_empty() {
            chunks.insert(idx, chunk);
            break;
        }
        chunks.insert(idx, right);
        chunks.insert(idx, left);
    }
    chunks
}

fn split_chunk_roughly(chunk: &str) -> (String, String) {
    let tokens = tokenize_subtitle_text(chunk);
    if tokens.len() <= 1 {
        return (chunk.to_string(), String::new());
    }
    let mid = tokens.len() / 2;
    let left = join_tokens(&tokens[..mid]);
    let right = join_tokens(&tokens[mid..]);
    (left, right)
}

fn tokenize_subtitle_text(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(current.clone());
                current.clear();
            }
            continue;
        }
        if is_cjk_char(ch) {
            if !current.is_empty() {
                tokens.push(current.clone());
                current.clear();
            }
            tokens.push(ch.to_string());
            continue;
        }
        current.push(ch);
        if matches!(ch, '.' | ',' | ';' | ':' | '?' | '!' | '。' | '，' | '；' | '：' | '？' | '！') {
            tokens.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn join_tokens(tokens: &[String]) -> String {
    let mut out = String::new();
    for token in tokens {
        if out.is_empty() {
            out.push_str(token);
        } else {
            out = join_pair(&out, token);
        }
    }
    out
}

fn join_pair(left: &str, right: &str) -> String {
    let Some(last) = left.chars().last() else {
        return right.to_string();
    };
    let Some(first) = right.chars().next() else {
        return left.to_string();
    };
    let no_space_before = matches!(first, '.' | ',' | ';' | ':' | '?' | '!' | ')' | ']' | '}' | '。' | '，' | '；' | '：' | '？' | '！' | '、');
    let no_space_after = matches!(last, '(' | '[' | '{' | '“' | '‘');
    let both_cjk = is_cjk_char(last) && is_cjk_char(first);
    if no_space_before || no_space_after || both_cjk {
        format!("{left}{right}")
    } else {
        format!("{left} {right}")
    }
}

fn visual_len(text: &str) -> usize {
    text.chars().map(|ch| if is_cjk_char(ch) { 2 } else { 1 }).sum()
}

fn is_cjk_char(ch: char) -> bool {
    matches!(ch as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x30FF | 0xAC00..=0xD7AF)
}

fn normalized_text(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}

#[derive(Debug, Clone)]
struct TranslationCueDraft {
    source: Vec<usize>,
    start: f64,
    end: f64,
    text: String,
}

async fn translate_entries(
    app: &AppHandle,
    id: &str,
    config: &TranslationConfig,
    entries: Vec<SubtitleEntry>,
    handle: &Arc<RunningTaskHandle>,
) -> Result<Vec<SubtitleEntry>> {
    if entries.is_empty() {
        return Ok(entries);
    }
    if matches!(config.provider, TranslationProvider::Mock) {
        emit(app, id, "info", "Mock 翻译：保留时间轴并回填原文", 0.84);
        return Ok(mock_translate_entries(entries));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.max(10)))
        .build()?;
    let blocks = split_translation_blocks(&entries, config.batch_size);
    let total_batches = blocks.len().max(1);
    let mut translated_entries = Vec::new();
    for (batch_index, (start, end)) in blocks.iter().copied().enumerate() {
        if *handle.cancel.borrow() {
            return Err(anyhow::Error::new(Cancelled));
        }
        let progress = 0.72 + (batch_index as f32 / total_batches as f32) * 0.18;
        emit(app, id, "info", &format!("翻译并重排第 {}/{} 个字幕块", batch_index + 1, total_batches), progress);
        let block = &entries[start..end];
        let mut cancel_rx = handle.cancel.subscribe();
        let mut block_entries = tokio::select! {
            r = openai_translate_layout(&client, config, block) => r.with_context(|| format!(
                "翻译块 {}-{} 失败",
                block.first().map(|e| e.index).unwrap_or(0),
                block.last().map(|e| e.index).unwrap_or(0),
            ))?,
            _ = cancel_rx.changed() => return Err(anyhow::Error::new(Cancelled)),
        };
        translated_entries.append(&mut block_entries);
    }
    let translated_entries = normalize_translated_entries(translated_entries);
    if translated_entries.is_empty() {
        return Err(anyhow!("翻译结果为空，已停止写出 srt"));
    }
    Ok(translated_entries)
}

fn mock_translate_entries(entries: Vec<SubtitleEntry>) -> Vec<SubtitleEntry> {
    entries.into_iter()
        .map(|mut entry| {
            entry.translated = Some(entry.text.clone());
            entry
        })
        .collect()
}

async fn openai_translate_layout(client: &reqwest::Client, config: &TranslationConfig, entries: &[SubtitleEntry]) -> Result<Vec<SubtitleEntry>> {
    let content = openai_translation_content(client, config, entries).await?;
    let drafts = parse_translation_cues(&content)?;
    layout_translation_cues(entries, drafts)
}

async fn openai_translation_content(client: &reqwest::Client, config: &TranslationConfig, entries: &[SubtitleEntry]) -> Result<String> {
    if config.api_key.trim().is_empty() {
        return Err(anyhow!("OpenAI-compatible API Key 为空"));
    }
    let items = format_translation_items(entries);
    let user_prompt = config.user_template
        .replace("{targetLanguage}", config.target_language.trim())
        .replace("{items}", &items);
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": config.model,
        "temperature": config.temperature,
        "messages": [
            { "role": "system", "content": config.system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });
    let response = client
        .post(url)
        .bearer_auth(config.api_key.trim())
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(anyhow!("翻译 API 请求失败：{} {}", status, text));
    }
    let value: Value = response.json().await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("翻译 API 响应缺少 choices[0].message.content"))?;
    Ok(content.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTranslationResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub sample_input: String,
    pub sample_output: String,
    pub message: String,
}

#[tauri::command]
async fn test_translation(config: TranslationConfig) -> Result<TestTranslationResult, String> {
    if config.base_url.trim().is_empty() {
        return Err("Base URL 为空".into());
    }
    if config.api_key.trim().is_empty() {
        return Err("API Key 为空".into());
    }
    if config.model.trim().is_empty() {
        return Err("Model 为空".into());
    }
    let sample = SubtitleEntry {
        index: 1,
        start: 0.0,
        end: 3.0,
        text: "Hello world, this is a translation test.".into(),
        translated: None,
    };
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.max(10)))
        .build()
        .map_err(|e| e.to_string())?;
    let result = openai_translate_layout(&client, &config, &[sample]).await;
    let latency_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(entries) => {
            let output = entries
                .iter()
                .filter_map(|entry| entry.translated.clone())
                .collect::<Vec<_>>()
                .join(" / ");
            let output = if output.trim().is_empty() {
                "(无返回内容)".into()
            } else {
                output
            };
            Ok(TestTranslationResult {
                ok: true,
                latency_ms,
                sample_input: "[1] 0.000 --> 3.000\nHello world, this is a translation test.".into(),
                sample_output: output,
                message: format!("成功 · {}ms", latency_ms),
            })
        }
        Err(error) => Ok(TestTranslationResult {
            ok: false,
            latency_ms,
            sample_input: "[1] 0.000 --> 3.000\nHello world, this is a translation test.".into(),
            sample_output: String::new(),
            message: format!("失败 · {}ms · {}", latency_ms, error),
        }),
    }
}

#[tauri::command]
async fn fetch_translation_models(config: TranslationConfig) -> Result<Vec<String>, String> {
    let base = config.base_url.trim();
    if base.is_empty() {
        return Err("Base URL 为空".into());
    }
    if config.api_key.trim().is_empty() {
        return Err("API Key 为空".into());
    }
    let url = format!("{}/models", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(to_string)?;
    let response = client
        .get(&url)
        .bearer_auth(config.api_key.trim())
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} · {text}"));
    }
    let value: Value = response.json().await.map_err(|e| format!("解析失败：{e}"))?;
    let models: Vec<String> = value
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err("响应未包含任何 model id".into());
    }
    Ok(models)
}

fn format_translation_items(entries: &[SubtitleEntry]) -> String {
    entries.iter()
        .map(|entry| {
            format!(
                "[{}] {:.3} --> {:.3}\n{}",
                entry.index,
                entry.start,
                entry.end,
                entry.text.replace('\n', " ").trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn split_translation_blocks(entries: &[SubtitleEntry], preferred_size: usize) -> Vec<(usize, usize)> {
    if entries.is_empty() {
        return Vec::new();
    }
    let max_entries = preferred_size.clamp(4, 24);
    let max_chars = 1200;
    let mut blocks = Vec::new();
    let mut start = 0;
    let mut chars = 0;

    for i in 0..entries.len() {
        chars += visual_len(&entries[i].text).max(1);
        let count = i - start + 1;
        let is_last = i + 1 == entries.len();
        let gap_after = if is_last { f64::INFINITY } else { entries[i + 1].start - entries[i].end };
        let semantic_break = (count >= 3 && ends_sentence_like(&entries[i].text)) || (count >= 2 && gap_after >= 1.0);
        if is_last || count >= max_entries || chars >= max_chars || semantic_break {
            blocks.push((start, i + 1));
            start = i + 1;
            chars = 0;
        }
    }
    blocks
}

fn ends_sentence_like(text: &str) -> bool {
    let Some(ch) = text.trim().chars().rev().find(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | ')' | ']' | '}' | '”' | '’' | '」' | '』')) else {
        return false;
    };
    matches!(ch, '.' | '?' | '!' | ';' | '。' | '？' | '！' | '；' | '…' | '؟' | '।' | '။')
}

fn strip_markdown_fences(content: &str) -> String {
    content
        .lines()
        .filter(|line| !line.trim_start().starts_with("\x60\x60\x60"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_translation_cues(content: &str) -> Result<Vec<TranslationCueDraft>> {
    let normalized = strip_markdown_fences(content);
    let start = normalized.find(['{', '[']).ok_or_else(|| anyhow!("翻译结果不是 JSON：缺少 {{ 或 ["))?;
    let end = normalized.rfind(['}', ']']).ok_or_else(|| anyhow!("翻译结果不是 JSON：缺少 }} 或 ]"))?;
    if end <= start {
        return Err(anyhow!("翻译结果 JSON 范围无效"));
    }
    let value = serde_json::from_str::<Value>(&normalized[start..=end])
        .with_context(|| "翻译结果不是合法 JSON")?;
    let cues = match &value {
        Value::Object(obj) => obj.get("cues").and_then(Value::as_array),
        Value::Array(arr) => Some(arr),
        _ => None,
    }.ok_or_else(|| anyhow!("翻译结果必须包含 cues 数组"))?;

    let mut drafts = Vec::new();
    for cue in cues {
        let Value::Object(obj) = cue else { continue };
        let text = obj.get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("cue 缺少 text"))?
            .to_string();
        let start = obj.get("start").and_then(json_seconds).ok_or_else(|| anyhow!("cue 缺少 start"))?;
        let end = obj.get("end").and_then(json_seconds).ok_or_else(|| anyhow!("cue 缺少 end"))?;
        let source = obj.get("source")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect::<Vec<_>>())
            .unwrap_or_default();
        drafts.push(TranslationCueDraft { source, start, end, text });
    }
    if drafts.is_empty() {
        return Err(anyhow!("翻译结果 cues 为空"));
    }
    Ok(drafts)
}

fn json_seconds(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    let text = value.as_str()?.trim();
    text.parse::<f64>().ok().or_else(|| parse_timecode_seconds(text))
}

fn parse_timecode_seconds(text: &str) -> Option<f64> {
    let normalized = text.replace(',', ".");
    let parts = normalized.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        [h, m, s] => Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?),
        [m, s] => Some(m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?),
        _ => None,
    }
}

fn layout_translation_cues(source_entries: &[SubtitleEntry], mut drafts: Vec<TranslationCueDraft>) -> Result<Vec<SubtitleEntry>> {
    if source_entries.is_empty() {
        return Ok(Vec::new());
    }
    let block_start = source_entries.first().map(|e| e.start).unwrap_or(0.0);
    let block_end = source_entries.last().map(|e| e.end).unwrap_or(block_start);
    drafts.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = Vec::new();
    let mut cursor = block_start;
    for draft in drafts {
        let start = draft.start.clamp(block_start, block_end).max(cursor);
        let end = draft.end.clamp(start + 0.35, block_end);
        if end <= start + 0.25 {
            continue;
        }
        let source_text = source_text_for_cue(source_entries, &draft.source, start, end);
        push_translated_cue_chunks(&mut out, source_text, start, end, &draft.text);
        cursor = out.last().map(|entry| entry.end + 0.04).unwrap_or(end + 0.04);
        if cursor >= block_end {
            break;
        }
    }
    if out.is_empty() {
        return Err(anyhow!("翻译结果没有可用 cue"));
    }
    Ok(out)
}

fn source_text_for_cue(entries: &[SubtitleEntry], source: &[usize], start: f64, end: f64) -> String {
    let selected = if source.is_empty() {
        entries.iter()
            .filter(|entry| entry.end > start - 0.05 && entry.start < end + 0.05)
            .collect::<Vec<_>>()
    } else {
        entries.iter()
            .filter(|entry| source.contains(&entry.index))
            .collect::<Vec<_>>()
    };
    let selected = if selected.is_empty() { entries.iter().collect::<Vec<_>>() } else { selected };
    selected.iter()
        .map(|entry| entry.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn push_translated_cue_chunks(out: &mut Vec<SubtitleEntry>, source_text: String, start: f64, end: f64, translated: &str) {
    const MAX_TRANSLATED_CUE_CHARS: usize = 42;
    const MAX_TRANSLATED_CUE_DURATION: f64 = 7.0;
    const MIN_TRANSLATED_CUE_DURATION: f64 = 0.85;

    let translated = translated.trim();
    if translated.is_empty() {
        return;
    }
    let duration = (end - start).max(MIN_TRANSLATED_CUE_DURATION);
    let mut chunks = split_subtitle_text(translated, MAX_TRANSLATED_CUE_CHARS);
    let target_count = chunks.len().max((duration / MAX_TRANSLATED_CUE_DURATION).ceil() as usize).max(1);
    chunks = rebalance_chunks(chunks, target_count, MAX_TRANSLATED_CUE_CHARS);

    if chunks.len() <= 1 {
        out.push(SubtitleEntry {
            index: 0,
            start,
            end: end.min(start + MAX_TRANSLATED_CUE_DURATION).max(start + MIN_TRANSLATED_CUE_DURATION),
            text: source_text,
            translated: Some(translated.to_string()),
        });
        return;
    }

    let usable_span = duration.min(chunks.len() as f64 * MAX_TRANSLATED_CUE_DURATION).max(chunks.len() as f64 * MIN_TRANSLATED_CUE_DURATION);
    let weights = chunks.iter().map(|chunk| visual_len(chunk).max(1) as f64).collect::<Vec<_>>();
    let total_weight = weights.iter().sum::<f64>().max(1.0);
    let mut cursor = start;
    for (idx, chunk) in chunks.iter().enumerate() {
        let is_last = idx + 1 == chunks.len();
        let share = (usable_span * (weights[idx] / total_weight)).clamp(MIN_TRANSLATED_CUE_DURATION, MAX_TRANSLATED_CUE_DURATION);
        let chunk_end = if is_last { (start + usable_span).min(end) } else { (cursor + share).min(end) };
        if chunk_end <= cursor + 0.25 {
            break;
        }
        out.push(SubtitleEntry {
            index: 0,
            start: cursor,
            end: chunk_end,
            text: source_text.clone(),
            translated: Some(chunk.trim().to_string()),
        });
        cursor = chunk_end + 0.04;
        if cursor >= end {
            break;
        }
    }
}

fn normalize_translated_entries(mut entries: Vec<SubtitleEntry>) -> Vec<SubtitleEntry> {
    const GAP_BEFORE_NEXT: f64 = 0.08;
    const MAX_DURATION: f64 = 7.0;
    entries.retain(|entry| entry.translated.as_deref().map(str::trim).is_some_and(|text| !text.is_empty()));
    entries.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    for i in 0..entries.len() {
        if i + 1 < entries.len() {
            let latest_end = (entries[i + 1].start - GAP_BEFORE_NEXT).max(entries[i].start + 0.25);
            if entries[i].end > latest_end {
                entries[i].end = latest_end;
            }
        }
        if entries[i].end > entries[i].start + MAX_DURATION {
            entries[i].end = entries[i].start + MAX_DURATION;
        }
        if entries[i].end <= entries[i].start + 0.25 {
            entries[i].end = entries[i].start + 0.85;
        }
        entries[i].index = i + 1;
    }
    entries
}

fn default_archive_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("找不到用户目录"))?;
    Ok(home.join(".sayiiwhat"))
}

fn effective_archive_root(debug: &DebugConfig) -> Result<PathBuf> {
    if debug.enabled {
        let trimmed = debug.archive_root.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.file_name().and_then(|n| n.to_str()) == Some(".sayiiwhat") {
                return Ok(path);
            }
            return Ok(path.join(".sayiiwhat"));
        }
    }
    default_archive_root()
}

fn tasks_root_under(archive_root: &Path) -> PathBuf {
    archive_root.join("tasks")
}

fn task_dir_under(archive_root: &Path, id: &str) -> PathBuf {
    tasks_root_under(archive_root).join(id)
}

fn write_task_meta_at(archive_root: &Path, meta: &ArchivedTaskMeta) -> Result<()> {
    let dir = task_dir_under(archive_root, &meta.id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("meta.json");
    let text = serde_json::to_string_pretty(meta)?;
    fs::write(path, text)?;
    Ok(())
}

fn write_task_subtitles_at(archive_root: &Path, id: &str, records: &SubtitleRecords) -> Result<()> {
    let dir = task_dir_under(archive_root, id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("subtitles.json");
    let text = serde_json::to_string_pretty(records)?;
    fs::write(path, text)?;
    Ok(())
}

fn archive_root_from_state(state: &State<AppState>) -> PathBuf {
    state.archive_root.read().unwrap().clone()
}

fn bootstrap_config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir().context("无法定位应用配置目录")?;
    Ok(dir.join("config.json"))
}

fn settings_path_under(archive_root: &Path) -> PathBuf {
    archive_root.join("settings.json")
}

fn read_bootstrap_debug(app: &AppHandle) -> DebugConfig {
    let path = match bootstrap_config_path(app) {
        Ok(p) => p,
        Err(_) => return DebugConfig::default(),
    };
    if !path.is_file() {
        return DebugConfig::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return DebugConfig::default(),
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return DebugConfig::default(),
    };
    serde_json::from_value(value.get("debug").cloned().unwrap_or(Value::Null))
        .unwrap_or_default()
}

#[tauri::command]
async fn list_archived_tasks(state: State<'_, AppState>) -> Result<Vec<ArchivedTaskMeta>, String> {
    let root = tasks_root_under(&archive_root_from_state(&state));
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&root).map_err(to_string)? {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        let meta_path = entry.path().join("meta.json");
        if !meta_path.is_file() {
            continue;
        }
        let text = match fs::read_to_string(&meta_path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        match serde_json::from_str::<ArchivedTaskMeta>(&text) {
            Ok(meta) => items.push(meta),
            Err(_) => continue,
        }
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

#[tauri::command]
async fn read_task_subtitles(state: State<'_, AppState>, id: String) -> Result<SubtitleRecords, String> {
    let path = task_dir_under(&archive_root_from_state(&state), &id).join("subtitles.json");
    if !path.is_file() {
        return Err("字幕记录不存在".into());
    }
    let text = fs::read_to_string(&path).map_err(to_string)?;
    serde_json::from_str::<SubtitleRecords>(&text).map_err(to_string)
}

#[tauri::command]
async fn save_task_subtitles(state: State<'_, AppState>, id: String, records: SubtitleRecords) -> Result<(), String> {
    let archive_root = archive_root_from_state(&state);
    let meta_path = task_dir_under(&archive_root, &id).join("meta.json");
    if !meta_path.is_file() {
        return Err("任务不存在".into());
    }
    let meta_text = fs::read_to_string(&meta_path).map_err(to_string)?;
    let mut meta = serde_json::from_str::<ArchivedTaskMeta>(&meta_text).map_err(to_string)?;

    write_task_subtitles_at(&archive_root, &id, &records).map_err(to_string)?;

    let srt_path = PathBuf::from(&meta.output_path);
    let entries: Vec<SubtitleEntry> = records.entries.iter().map(|r| SubtitleEntry {
        index: r.index,
        start: r.start,
        end: r.end,
        text: r.text.clone(),
        translated: r.translated.clone(),
    }).collect();
    if !srt_path.as_os_str().is_empty() {
        if let Err(e) = write_srt(&srt_path, &entries) {
            return Err(format!("重新生成 srt 失败：{e}"));
        }
    }

    meta.subtitle_count = entries.len();
    meta.finished_at = Some(chrono::Utc::now().to_rfc3339());
    write_task_meta_at(&archive_root, &meta).map_err(to_string)?;
    Ok(())
}

#[tauri::command]
async fn delete_archived_tasks(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let root = tasks_root_under(&archive_root_from_state(&state));
    for id in ids {
        let dir = root.join(&id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(to_string)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn cancel_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let handle = {
        let map = state.running.lock().await;
        map.get(&id).cloned()
    };
    let Some(handle) = handle else { return Ok(()) };
    let _ = handle.cancel.send(true);
    Ok(())
}

#[tauri::command]
async fn open_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let target = if p.is_file() {
        p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
    } else {
        p
    };
    if !target.exists() {
        return Err(format!("路径不存在：{}", target.display()));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::process::Command::new("xdg-open").arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveOverview {
    pub root_path: String,
    pub settings_exists: bool,
    pub settings_size: u64,
    pub tasks_count: usize,
}

#[tauri::command]
async fn archive_overview(state: State<'_, AppState>) -> Result<ArchiveOverview, String> {
    let root = archive_root_from_state(&state);
    let settings_path = settings_path_under(&root);
    let settings_exists = settings_path.is_file();
    let settings_size = if settings_exists {
        fs::metadata(&settings_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    let tasks_dir = tasks_root_under(&root);
    let tasks_count = if tasks_dir.is_dir() {
        fs::read_dir(&tasks_dir)
            .map(|entries| entries.filter_map(Result::ok).filter(|e| e.path().is_dir()).count())
            .unwrap_or(0)
    } else {
        0
    };
    Ok(ArchiveOverview {
        root_path: root.to_string_lossy().into_owned(),
        settings_exists,
        settings_size,
        tasks_count,
    })
}

#[tauri::command]
async fn read_settings_file(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let root = archive_root_from_state(&state);
    let path = settings_path_under(&root);
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(to_string)?;
    Ok(Some(text))
}

pub fn write_srt(path: &Path, entries: &[SubtitleEntry]) -> Result<()> {
    let mut file = fs::File::create(path)?;
    for (idx, entry) in entries.iter().enumerate() {
        let body = entry.translated.clone().unwrap_or_else(|| entry.text.clone());
        writeln!(file, "{}", idx + 1)?;
        writeln!(file, "{} --> {}", srt_time(entry.start), srt_time(entry.end))?;
        writeln!(file, "{}\n", body)?;
    }
    Ok(())
}

fn srt_time(seconds: f64) -> String {
    let safe = seconds.max(0.0);
    let total_ms = (safe * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

fn format_seconds(seconds: f64) -> String {
    srt_time(seconds).replace(',', ".")
}

async fn run_and_stream(
    app: &AppHandle,
    id: &str,
    command: &mut Command,
    label: &str,
    handle: &Arc<RunningTaskHandle>,
) -> Result<()> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("无法启动 {label}"))?;

    let stdout = child.stdout.take().map(BufReader::new);
    let stderr = child.stderr.take().map(BufReader::new);

    let app_out = app.clone();
    let id_out = id.to_string();
    let stdout_task = tokio::spawn(async move {
        if let Some(reader) = stdout {
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    emit(&app_out, &id_out, "debug", &line, 0.0);
                }
            }
        }
    });

    let app_err = app.clone();
    let id_err = id.to_string();
    let stderr_task = tokio::spawn(async move {
        if let Some(reader) = stderr {
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    emit(&app_err, &id_err, "debug", &line, 0.0);
                }
            }
        }
    });

    if *handle.cancel.borrow() {
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        return Err(anyhow::Error::new(Cancelled));
    }

    let mut cancel_rx = handle.cancel.subscribe();
    let status = tokio::select! {
        r = child.wait() => r,
        _ = cancel_rx.changed() => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let cancelled = *handle.cancel.borrow();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(_) if cancelled => Err(anyhow::Error::new(Cancelled)),
        Ok(s) => Err(anyhow!("{label} 执行失败，退出码：{}", s)),
        Err(_e) if cancelled => Err(anyhow::Error::new(Cancelled)),
        Err(e) => Err(anyhow::Error::new(e)),
    }
}

fn emit(app: &AppHandle, id: &str, level: &str, message: &str, progress: f32) {
    let _ = app.emit("process-progress", ProgressEvent {
        id: id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        progress,
    });
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[allow(dead_code)]
fn new_task_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cues_json() {
        let parsed = parse_translation_cues(r#"{"cues":[{"source":[1,2],"start":1.0,"end":4.2,"text":"我们今天在这里。"}]}"#).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].source, vec![1, 2]);
        assert_eq!(parsed[0].start, 1.0);
        assert_eq!(parsed[0].end, 4.2);
        assert_eq!(parsed[0].text, "我们今天在这里。");
    }

    #[test]
    fn parses_fenced_cues_json_with_timecode() {
        let parsed = parse_translation_cues("```json\n{\"cues\":[{\"source\":[3],\"start\":\"00:00:05.000\",\"end\":\"00:00:08,500\",\"text\":\"确实如此。\"}]}\n```").unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].start, 5.0);
        assert_eq!(parsed[0].end, 8.5);
        assert_eq!(parsed[0].text, "确实如此。");
    }

    #[test]
    fn layouts_cues_and_splits_long_duration() {
        let source = vec![
            SubtitleEntry { index: 1, start: 1.0, end: 3.0, text: "We are here today because of".into(), translated: None },
            SubtitleEntry { index: 2, start: 3.1, end: 9.8, text: "the fact that we have what most people consider an unusual friendship.".into(), translated: None },
        ];
        let drafts = vec![TranslationCueDraft {
            source: vec![1, 2],
            start: 1.0,
            end: 9.8,
            text: "我们今天在这里，是因为我们拥有一段大多数人认为不寻常、但对我们来说已经很自然的友谊。".into(),
        }];
        let laid_out = normalize_translated_entries(layout_translation_cues(&source, drafts).unwrap());
        assert!(laid_out.len() >= 2);
        assert!(laid_out.iter().all(|entry| entry.end - entry.start <= 7.0 + 0.001));
        assert!(laid_out.iter().all(|entry| visual_len(entry.translated.as_deref().unwrap_or("")) <= 42));
    }

    #[test]
    fn splits_translation_blocks_on_sentence_and_gap() {
        let entries = vec![
            SubtitleEntry { index: 1, start: 0.0, end: 1.0, text: "Hello".into(), translated: None },
            SubtitleEntry { index: 2, start: 1.1, end: 2.0, text: "world.".into(), translated: None },
            SubtitleEntry { index: 3, start: 3.4, end: 4.0, text: "Next".into(), translated: None },
            SubtitleEntry { index: 4, start: 4.1, end: 5.0, text: "sentence.".into(), translated: None },
        ];
        let blocks = split_translation_blocks(&entries, 8);
        assert_eq!(blocks, vec![(0, 2), (2, 4)]);
    }

    #[test]
    fn srt_writer_prefers_translated_text() {
        let path = std::env::temp_dir().join(format!("sayiiwhat-test-{}.srt", new_task_id()));
        let entries = vec![SubtitleEntry {
            index: 1,
            start: 1.0,
            end: 2.5,
            text: "Hello world".into(),
            translated: Some("你好，世界。".into()),
        }];
        write_srt(&path, &entries).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert!(content.contains("你好，世界。"));
        assert!(!content.contains("Hello world"));
    }

    #[tokio::test]
    #[ignore]
    async fn real_api_translation_layout_smoke() {
        let api_key = std::env::var("SAYIIWHAT_TEST_API_KEY").expect("SAYIIWHAT_TEST_API_KEY missing");
        let base_url = std::env::var("SAYIIWHAT_TEST_BASE_URL").expect("SAYIIWHAT_TEST_BASE_URL missing");
        let model = std::env::var("SAYIIWHAT_TEST_MODEL").expect("SAYIIWHAT_TEST_MODEL missing");

        let config = TranslationConfig {
            enabled: true,
            provider: TranslationProvider::OpenAiCompatible,
            base_url,
            api_key,
            model,
            target_language: "简体中文".into(),
            temperature: 0.1,
            timeout_seconds: 120,
            batch_size: 8,
            system_prompt: DEFAULT_SYSTEM_PROMPT.into(),
            user_template: DEFAULT_USER_TEMPLATE.into(),
        };

        let source = vec![
            SubtitleEntry { index: 1, start: 16.390, end: 20.839, text: "We are here today because of".into(), translated: None },
            SubtitleEntry { index: 2, start: 20.959, end: 24.460, text: "the fact that we have what most people consider an unusual friendship.".into(), translated: None },
            SubtitleEntry { index: 3, start: 25.020, end: 28.500, text: "And it is. And yet it feels natural to us now.".into(), translated: None },
        ];

        let out = openai_translate_layout(&config, &source).await.unwrap();
        assert!(!out.is_empty());
        assert!(out.iter().all(|entry| entry.translated.as_deref().map(str::trim).is_some_and(|text| !text.is_empty())));
        assert!(out.iter().all(|entry| entry.end > entry.start));
        assert!(out.iter().all(|entry| entry.end - entry.start <= 7.0 + 0.001));
        for pair in out.windows(2) {
            assert!(pair[0].end <= pair[1].start + 0.001);
        }
        let path = std::env::temp_dir().join(format!("sayiiwhat-real-api-{}.srt", new_task_id()));
        write_srt(&path, &out).unwrap();
        let srt = fs::read_to_string(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert!(srt.contains("-->"));
        assert!(!srt.contains("We are here today because of"));

        let english_config = TranslationConfig {
            target_language: "English".into(),
            ..config
        };
        let japanese_source = vec![
            SubtitleEntry { index: 1, start: 1.0, end: 3.4, text: "私はずっと一人で".into(), translated: None },
            SubtitleEntry { index: 2, start: 3.5, end: 6.2, text: "旅をしてきました。".into(), translated: None },
        ];
        let english_out = openai_translate_layout(&english_config, &japanese_source).await.unwrap();
        assert!(!english_out.is_empty());
        assert!(english_out.iter().all(|entry| entry.translated.as_deref().map(str::trim).is_some_and(|text| !text.is_empty())));
        assert!(english_out.iter().all(|entry| entry.end > entry.start));
        assert!(english_out.iter().all(|entry| entry.end - entry.start <= 7.0 + 0.001));
    }
}
