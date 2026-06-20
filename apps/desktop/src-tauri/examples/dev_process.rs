use anyhow::{anyhow, Context, Result};
use sayiiwhat_lib::{
    dedupe_and_normalize, parse_whisper_json, polish_subtitle_timing, write_srt, AppConfig,
    TranslationProvider,
};
use std::{
    env,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() -> Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 2 {
        return Err(anyhow!("usage: dev_process <model.bin> <video...>"));
    }
    let model = PathBuf::from(&args[0]);
    let videos = args[1..].iter().map(PathBuf::from).collect::<Vec<_>>();
    let config = AppConfig {
        model_path: model.to_string_lossy().to_string(),
        translation: vec![sayiiwhat_lib::TranslationConfig {
            id: "mock".into(),
            name: "Mock".into(),
            enabled: true,
            provider: TranslationProvider::Mock,
            ..Default::default()
        }],
        ..Default::default()
    };

    for video in videos {
        process_one(&config, &video)?;
    }
    Ok(())
}

fn process_one(config: &AppConfig, video: &Path) -> Result<()> {
    if !video.is_file() {
        return Err(anyhow!("video not found: {}", video.display()));
    }
    let model = Path::new(&config.model_path);
    if !model.is_file() {
        return Err(anyhow!("model not found: {}", model.display()));
    }

    let temp = tempfile::tempdir()?;
    let wav = temp.path().join("source.wav");
    let json_base = temp.path().join("whisper");
    let ffmpeg = if Path::new("resources/bin/macos/ffmpeg").is_file() {
        PathBuf::from("resources/bin/macos/ffmpeg")
    } else {
        PathBuf::from("ffmpeg")
    };
    println!("extract audio: {}", video.display());
    run(Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(video)
        .arg("-vn")
        .arg("-af")
        .arg("aresample=async=1")
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&wav))?;

    println!("transcribe: {}", video.display());
    let whisper_cli = if Path::new("resources/bin/macos/whisper-cli").is_file() {
        PathBuf::from("resources/bin/macos/whisper-cli")
    } else {
        PathBuf::from("whisper-cli")
    };
    run(Command::new(whisper_cli)
        .arg("-m")
        .arg(model)
        .arg("-l")
        .arg(&config.language)
        .arg("-oj")
        .arg("-of")
        .arg(&json_base)
        .arg("--no-prints")
        .arg("-f")
        .arg(&wav))?;

    let json_text = fs::read_to_string(json_base.with_extension("json")).context("read whisper json")?;
    let mut entries = polish_subtitle_timing(dedupe_and_normalize(parse_whisper_json(&json_text, 0.0, None)?));
    if config.translation.iter().any(|item| item.enabled && item.provider == TranslationProvider::Mock) {
        for entry in &mut entries {
            entry.translated = Some(entry.text.clone());
        }
    }
    let output = video.with_extension("srt");
    write_srt(&output, &entries)?;
    println!("wrote {} ({} subtitles)", output.display(), entries.len());
    Ok(())
}

fn run(command: &mut Command) -> Result<()> {
    let status = command.status()?;
    if !status.success() {
        return Err(anyhow!("command failed: {status}"));
    }
    Ok(())
}
