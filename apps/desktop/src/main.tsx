import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./tokens.css";
import "./styles.css";

type TranslationProvider = "mock" | "openAiCompatible";
type TaskStatus = "queued" | "running" | "cancelled" | "done" | "failed";
type TabKey = "queue" | "history" | "api" | "model" | "debug";
type HistoryFilter = "all" | "done" | "failed" | "cancelled";
type LogCategory = "queue" | "vad" | "audio" | "segment" | "transcribe" | "translate" | "post" | "output" | "failed" | "info" | "debug";

interface DebugConfig {
  enabled: boolean;
  archiveRoot: string;
}

interface LogEntry {
  message: string;
  level: "info" | "success" | "debug";
  category: LogCategory;
  timestamp: number;
}

interface ArchivedTask {
  id: string;
  videoPath: string;
  outputPath: string;
  status: "running" | "cancelled" | "done" | "failed";
  vadEnabled: boolean;
  vadThreshold: number;
  translationEnabled: boolean;
  translationConfigId?: string;
  translationConfigName?: string;
  subtitleCount: number;
  usedSegments: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface SubtitleRecord {
  index: number;
  start: number;
  end: number;
  text: string;
  translated?: string;
}

interface SubtitleRecords {
  entries: SubtitleRecord[];
}

const DEFAULT_SYSTEM_PROMPT = "你是专业影视字幕译审。请把 Whisper 识别出的字幕翻译/润色为用户指定的目标语言；结合上下文修正明显断句、大小写和轻微识别错误。译文要口语、简短、适合屏幕阅读，不添加解释。";
const DEFAULT_USER_TEMPLATE = "请处理下面字幕块。原文可能是 Whisper 支持的任意语言，请自动判断源语言，并翻译/润色为目标语言：{targetLanguage}。\n\n你需要同时做两件事：\n1. 结合上下文修正 Whisper 可能造成的半句、断句、大小写和轻微识别错误。\n2. 在不改变整体时间范围的前提下，生成更自然的最终目标语言字幕时间轴；可以合并相邻半句，也可以把过长译文拆成多条。\n\n时间轴规则：\n- 每条 cue 的 start/end 使用数字秒，必须位于输入字幕块的时间范围内。\n- cue 必须按时间递增，不能重叠。\n- 单条 cue 建议 1.2–6.5 秒，尽量不要超过 7 秒。\n- 不要让一句完整长句长时间停留在屏幕上；长句要拆成自然的 2–3 条短字幕。\n- 每条字幕应简短、口语、适合屏幕阅读。\n\n只返回严格 JSON，不要 Markdown，不要解释。格式：\n{\"cues\":[{\"source\":[1,2],\"start\":12.34,\"end\":15.67,\"text\":\"目标语言字幕\"}]}\n\n输入字幕：\n{items}";

const LOG_CATEGORY_LABELS: Record<LogCategory, string> = {
  queue: "队列",
  vad: "VAD",
  audio: "音频",
  segment: "分段",
  transcribe: "识别",
  translate: "翻译",
  post: "后处理",
  output: "输出",
  failed: "失败",
  info: "信息",
  debug: "调试",
};

function categorizeLog(message: string, level: string): LogCategory {
  if (level === "debug") return "debug";
  if (level === "success") return "output";
  if (message.includes("失败") || message.includes("错误") || message.includes("无法")) return "failed";
  if (message.includes("VAD") || message.includes("人声检测")) return "vad";
  if (message.includes("ffmpeg") || message.includes("音频") || message.includes("抽出")) return "audio";
  if (message.includes("切分音频段") || message.includes("分段模式") || message.includes("整段识别")) return "segment";
  if (message.includes("识别")) return "transcribe";
  if (message.includes("翻译") || message.includes("润色")) return "translate";
  if (message.includes("时间轴")) return "post";
  if (message.includes("写出") || message.includes("输出") || message.includes("完成") || message.includes("未启用翻译")) return "output";
  if (message.includes("已加入") || message.includes("开始处理") || message.includes("准备临时")) return "queue";
  return "info";
}

function makeLog(message: string, level: "info" | "success" | "debug" = "info"): LogEntry {
  return { message, level, category: categorizeLog(message, level), timestamp: Date.now() };
}

function formatLogTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

interface TranslationConfig {
  id: string;
  name: string;
  enabled: boolean;
  provider: TranslationProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  temperature: number;
  timeoutSeconds: number;
  batchSize: number;
  systemPrompt: string;
  userTemplate: string;
}

interface AppConfig {
  modelPath: string;
  language: string;
  ffmpegPath: string;
  ffprobePath: string;
  whisperPath: string;
  autoSegment: boolean;
  segmentThresholdMinutes: number;
  segmentMinutes: number;
  overlapSeconds: number;
  translation: TranslationConfig[];
  debug: DebugConfig;
}

interface QueueTask {
  id: string;
  videoPath: string;
  vadEnabled: boolean;
  vadThreshold: number;
  translationEnabled: boolean;
  translationConfigId: string;
  translationConfigName?: string;
  status: TaskStatus;
  progress: number;
  outputPath?: string;
  subtitleCount?: number;
  usedSegments?: number;
  error?: string;
  logs: LogEntry[];
}

interface TaskOptions {
  vadEnabled: boolean;
  vadThreshold: number;
  translationEnabled: boolean;
  translationConfigId: string;
}

interface ProgressEvent {
  id: string;
  level: string;
  message: string;
  progress: number;
}

interface ProcessVideoResult {
  id: string;
  videoPath: string;
  outputPath: string;
  subtitleCount: number;
  usedSegments: number;
}

interface ToolCheck {
  ok: boolean;
  path: string;
  message: string;
}

interface ToolStatus {
  ffmpeg: ToolCheck;
  ffprobe: ToolCheck;
  whisper: ToolCheck;
}

interface TestTranslationResult {
  ok: boolean;
  latencyMs: number;
  sampleInput: string;
  sampleOutput: string;
  message: string;
}

const defaultConfig: AppConfig = {
  modelPath: "",
  language: "auto",
  ffmpegPath: "",
  ffprobePath: "",
  whisperPath: "",
  autoSegment: true,
  segmentThresholdMinutes: 30,
  segmentMinutes: 15,
  overlapSeconds: 3,
  translation: [{
    id: "",
    name: "默认",
    enabled: true,
    provider: "openAiCompatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    targetLanguage: "简体中文",
    temperature: 0.2,
    timeoutSeconds: 120,
    batchSize: 40,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
  }],
  debug: {
    enabled: false,
    archiveRoot: "",
  },
};

const vadThresholdOptions = [
  { value: 0.3, label: "0.30 宽松", detail: "少漏字，适合轻声、远距离收音，但可能多收一点噪声。" },
  { value: 0.5, label: "0.50 均衡推荐", detail: "0.50作为多数视频的起点，兼顾漏识别和噪声误识别。" },
  { value: 0.7, label: "0.70 严格", detail: "减少音乐、掌声、环境声误触发，但轻声片段可能被过滤。" },
];

const languageOptions = [
  ["auto", "auto · 自动检测"],
  ["en", "en · 英语"],
  ["zh", "zh · 中文"],
  ["yue", "yue · 粤语"],
  ["ja", "ja · 日语"],
  ["ko", "ko · 韩语"],
  ["fr", "fr · 法语"],
  ["de", "de · 德语"],
  ["es", "es · 西班牙语"],
  ["pt", "pt · 葡萄牙语"],
  ["it", "it · 意大利语"],
  ["ru", "ru · 俄语"],
  ["ar", "ar · 阿拉伯语"],
  ["hi", "hi · 印地语"],
  ["vi", "vi · 越南语"],
  ["th", "th · 泰语"],
  ["id", "id · 印尼语"],
  ["ms", "ms · 马来语"],
  ["tr", "tr · 土耳其语"],
  ["nl", "nl · 荷兰语"],
  ["pl", "pl · 波兰语"],
  ["uk", "uk · 乌克兰语"],
  ["sv", "sv · 瑞典语"],
  ["fi", "fi · 芬兰语"],
  ["da", "da · 丹麦语"],
  ["no", "no · 挪威语"],
  ["nn", "nn · 新挪威语"],
  ["cs", "cs · 捷克语"],
  ["sk", "sk · 斯洛伐克语"],
  ["hu", "hu · 匈牙利语"],
  ["ro", "ro · 罗马尼亚语"],
  ["bg", "bg · 保加利亚语"],
  ["sr", "sr · 塞尔维亚语"],
  ["hr", "hr · 克罗地亚语"],
  ["bs", "bs · 波斯尼亚语"],
  ["sl", "sl · 斯洛文尼亚语"],
  ["el", "el · 希腊语"],
  ["he", "he · 希伯来语"],
  ["fa", "fa · 波斯语"],
  ["ur", "ur · 乌尔都语"],
  ["bn", "bn · 孟加拉语"],
  ["ta", "ta · 泰米尔语"],
  ["te", "te · 泰卢固语"],
  ["ml", "ml · 马拉雅拉姆语"],
  ["kn", "kn · 卡纳达语"],
  ["mr", "mr · 马拉地语"],
  ["gu", "gu · 古吉拉特语"],
  ["pa", "pa · 旁遮普语"],
  ["si", "si · 僧伽罗语"],
  ["ne", "ne · 尼泊尔语"],
  ["sa", "sa · 梵语"],
  ["km", "km · 高棉语"],
  ["lo", "lo · 老挝语"],
  ["my", "my · 缅甸语"],
  ["bo", "bo · 藏语"],
  ["mn", "mn · 蒙古语"],
  ["kk", "kk · 哈萨克语"],
  ["uz", "uz · 乌兹别克语"],
  ["tg", "tg · 塔吉克语"],
  ["az", "az · 阿塞拜疆语"],
  ["tt", "tt · 鞑靼语"],
  ["ba", "ba · 巴什基尔语"],
  ["be", "be · 白俄罗斯语"],
  ["mk", "mk · 马其顿语"],
  ["sq", "sq · 阿尔巴尼亚语"],
  ["lt", "lt · 立陶宛语"],
  ["lv", "lv · 拉脱维亚语"],
  ["et", "et · 爱沙尼亚语"],
  ["is", "is · 冰岛语"],
  ["fo", "fo · 法罗语"],
  ["cy", "cy · 威尔士语"],
  ["ga", "ga · 爱尔兰语"],
  ["gd", "gd · 苏格兰盖尔语"],
  ["ca", "ca · 加泰罗尼亚语"],
  ["gl", "gl · 加利西亚语"],
  ["eu", "eu · 巴斯克语"],
  ["br", "br · 布列塔尼语"],
  ["oc", "oc · 奥克语"],
  ["la", "la · 拉丁语"],
  ["mt", "mt · 马耳他语"],
  ["lb", "lb · 卢森堡语"],
  ["af", "af · 南非荷兰语"],
  ["sw", "sw · 斯瓦希里语"],
  ["am", "am · 阿姆哈拉语"],
  ["ha", "ha · 豪萨语"],
  ["yo", "yo · 约鲁巴语"],
  ["so", "so · 索马里语"],
  ["sn", "sn · 修纳语"],
  ["ln", "ln · 林加拉语"],
  ["mg", "mg · 马尔加什语"],
  ["tl", "tl · 他加禄语"],
  ["haw", "haw · 夏威夷语"],
  ["mi", "mi · 毛利语"],
  ["jw", "jw · 爪哇语"],
  ["su", "su · 巽他语"],
  ["ht", "ht · 海地克里奥尔语"],
  ["yi", "yi · 意第绪语"],
  ["sd", "sd · 信德语"],
  ["ps", "ps · 普什图语"],
  ["tk", "tk · 土库曼语"],
  ["hy", "hy · 亚美尼亚语"],
  ["ka", "ka · 格鲁吉亚语"],
  ["as", "as · 阿萨姆语"],
] as const;

function Logo({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <svg className={className} viewBox="0 0 260 80" xmlns="http://www.w3.org/2000/svg" aria-label="SayiiWHAT" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <rect x="2" y="22" width="48" height="48" rx="13" fill="var(--color-accent)" stroke="var(--color-rule)" strokeWidth="3" />
      <rect x="11" y="40" width="4.5" height="12" rx="2" fill="var(--color-ink)" />
      <rect x="19" y="35" width="4.5" height="22" rx="2" fill="var(--color-ink)" />
      <rect x="27" y="30" width="4.5" height="32" rx="2" fill="var(--color-ink)" />
      <rect x="35" y="36" width="4.5" height="20" rx="2" fill="var(--color-ink)" />
      <text
        x="60"
        y="64"
        fontFamily="ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', ui-sans-serif, system-ui, sans-serif"
        fontSize="40"
        fontWeight="900"
        fill="var(--color-ink)"
        letterSpacing="-1.5"
      >
        Sayii
      </text>
      <g transform="rotate(-9 175 30)">
        <text
          x="150"
          y="38"
          fontFamily="ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', ui-sans-serif, system-ui, sans-serif"
          fontSize="24"
          fontWeight="950"
          fill="#5b73e8"
          stroke="var(--color-ink)"
          strokeWidth="1.5"
          letterSpacing="-0.8"
          paintOrder="stroke fill"
        >
          WHAT
        </text>
      </g>
    </svg>
  );
}

function App() {
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<ArchivedTask[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("queue");
  const [isProcessing, setIsProcessing] = useState(false);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [activeTranslationId, setActiveTranslationId] = useState<string>("");
  const [taskOptions, setTaskOptions] = useState<TaskOptions>({ vadEnabled: true, vadThreshold: 0.5, translationEnabled: false, translationConfigId: "" });
  const processingRef = useRef(false);
  const tasksRef = useRef<QueueTask[]>([]);
  const translationTouchedRef = useRef(false);
  const configHydratedRef = useRef(false);
  const logoClickCountRef = useRef(0);
  const logoClickResetTimerRef = useRef<number | null>(null);
  const [debugEntryConfirm, setDebugEntryConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 1500);
  }, []);

  const refreshArchived = useCallback(async () => {
    try {
      const list = await invoke<ArchivedTask[]>("list_archived_tasks");
      setArchivedTasks(list);
    } catch (error) {
      console.warn("list_archived_tasks failed:", error);
    }
  }, []);

  const handleLogoClick = useCallback(() => {
    if (logoClickResetTimerRef.current !== null) {
      window.clearTimeout(logoClickResetTimerRef.current);
    }
    logoClickCountRef.current += 1;
    const count = logoClickCountRef.current;
    const remaining = 8 - count;
    const action = activeTab === "debug" ? "关闭" : "打开";

    if (count >= 8) {
      logoClickCountRef.current = 0;
      if (activeTab === "debug") {
        setActiveTab("queue");
        setConfig((current) => ({ ...current, debug: { ...current.debug, enabled: false } }));
        showToast("DEBUG 模式已关闭");
      } else {
        setDebugEntryConfirm(true);
      }
      return;
    }

    if (count > 3) {
      showToast(`继续点击 ${remaining} 次后${action} DEBUG 设置`);
    }

    logoClickResetTimerRef.current = window.setTimeout(() => {
      logoClickCountRef.current = 0;
      logoClickResetTimerRef.current = null;
    }, 2000);
  }, [activeTab, showToast]);

  useEffect(() => {
    refreshArchived();
  }, [refreshArchived]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void refreshArchived();
    }, 500);
    return () => window.clearTimeout(handle);
  }, [config.debug.enabled, config.debug.archiveRoot, refreshArchived]);

  const translationConfigured = useMemo(() => {
    const t = config.translation.find((c) => c.id === taskOptions.translationConfigId);
    return Boolean(t && t.baseUrl.trim() && t.apiKey.trim() && t.model.trim());
  }, [config.translation, taskOptions.translationConfigId]);

  useEffect(() => {
    if (translationTouchedRef.current) return;
    setTaskOptions((current) => (current.translationEnabled === translationConfigured ? current : { ...current, translationEnabled: translationConfigured }));
  }, [translationConfigured]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((loaded) => {
        const loadedTranslations = Array.isArray(loaded.translation) ? loaded.translation : [];
        const translations = (loadedTranslations.length > 0 ? loadedTranslations : defaultConfig.translation)
          .map((t) => ({
            ...defaultConfig.translation[0],
            ...t,
            id: t.id || crypto.randomUUID(),
          }));
        const firstId = translations[0]?.id ?? "";
        setConfig({
          ...defaultConfig,
          ...loaded,
          translation: translations,
          debug: { ...defaultConfig.debug, ...loaded.debug },
        });
        setActiveTranslationId(firstId);
        setTaskOptions((cur) => ({ ...cur, translationConfigId: firstId }));
        // Only allow auto-save once the real disk config has been hydrated,
        // otherwise the default (empty) config would be written back and wipe
        // the user's apiKey/baseUrl/model on disk.
        configHydratedRef.current = true;
      })
      .catch((error) => appendGlobalLog(String(error)));

    const unlistenPromise = listen<ProgressEvent>("process-progress", (event) => {
      const progress = event.payload;
      setTasks((current) => current.map((task) => {
        if (task.id !== progress.id) return task;
        const entry = makeLog(progress.message, progress.level as "info" | "success" | "debug");
        return {
          ...task,
          progress: progress.progress > 0 ? progress.progress : task.progress,
          logs: [...task.logs, entry].slice(-500),
        };
      }));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!configHydratedRef.current) return;
    invoke("save_config", { config }).catch((error) => appendGlobalLog(String(error)));
  }, [config]);

  const summary = useMemo(() => ({
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    done: archivedTasks.filter((task) => task.status === "done").length,
    failed: archivedTasks.filter((task) => task.status === "failed").length,
    cancelled: archivedTasks.filter((task) => task.status === "cancelled").length,
  }), [tasks, archivedTasks]);
  const sessionFailedTasks = useMemo(
    () => tasks.filter((task) => task.status === "failed"),
    [tasks],
  );
  const logsByTaskId = useMemo(() => {
    const map: Record<string, LogEntry[]> = {};
    for (const task of tasks) {
      if (task.logs && task.logs.length > 0) {
        map[task.id] = task.logs;
      }
    }
    return map;
  }, [tasks]);
  const [showFailedDialog, setShowFailedDialog] = useState(false);
  const activeTask = tasks.find((task) => task.status === "running");

  const modelName = useMemo(() => {
    if (!config.modelPath) return "尚未选择模型";
    return config.modelPath.split(/[\\/]/).at(-1) ?? config.modelPath;
  }, [config.modelPath]);

  const activeTranslation = useMemo(
    () => config.translation.find((c) => c.id === activeTranslationId) ?? config.translation[0],
    [config.translation, activeTranslationId],
  );

  const chooseVideos = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const selectedConfigName = config.translation.find((c) => c.id === taskOptions.translationConfigId)?.name ?? "";
    setTasks((current) => [
      ...current,
      ...paths.map((path) => ({
        id: crypto.randomUUID(),
        videoPath: path,
        vadEnabled: taskOptions.vadEnabled,
        vadThreshold: taskOptions.vadThreshold,
        translationEnabled: taskOptions.translationEnabled,
        translationConfigId: taskOptions.translationConfigId,
        translationConfigName: selectedConfigName,
        status: "queued" as TaskStatus,
        progress: 0,
        logs: [makeLog("已加入队列" + (taskOptions.vadEnabled ? " · VAD " + taskOptions.vadThreshold.toFixed(2) : " · VAD 关") + (taskOptions.translationEnabled ? ` · 翻译开 · ${selectedConfigName}` : " · 翻译关"))],
      })),
    ]);
  };

  const chooseModel = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "whisper.cpp model", extensions: ["bin"] }],
    });
    if (typeof selected === "string") {
      setConfig((current) => ({ ...current, modelPath: selected }));
    }
  };

  const chooseBinary = async (key: "ffmpegPath" | "ffprobePath" | "whisperPath") => {
    const selected = await open({ multiple: false });
    if (typeof selected === "string") {
      setConfig((current) => ({ ...current, [key]: selected }));
    }
  };

  const checkTools = async () => {
    const status = await invoke<ToolStatus>("check_tools", { config });
    setToolStatus(status);
  };

  const startQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);
    try {
      while (true) {
        const next = tasksRef.current.find((task) => task.status === "queued");
        if (!next) break;
        setTasks((current) => current.map((task) => task.id === next.id ? { ...task, status: "running", logs: [...task.logs, makeLog("开始处理")] } : task));
        try {
          const result = await invoke<ProcessVideoResult>("process_video", {
            request: {
              id: next.id,
              videoPath: next.videoPath,
              config,
              translationConfigId: next.translationEnabled ? next.translationConfigId : null,
              debugSegmentSeconds: null,
              vadEnabled: next.vadEnabled,
              vadThreshold: next.vadThreshold,
            },
          });
          setTasks((current) => current.map((task) => task.id === next.id ? {
            ...task,
            status: "done",
            progress: 1,
            outputPath: result.outputPath,
            subtitleCount: result.subtitleCount,
            usedSegments: result.usedSegments,
            logs: [...task.logs, makeLog(`输出完成：${result.outputPath}`, "success")],
          } : task));
          await refreshArchived();
        } catch (error) {
          const message = String(error);
          const isCancelled = message.includes("用户已中止") || message.includes("Cancelled");
          setTasks((current) => current.map((task) => task.id === next.id ? {
            ...task,
            status: isCancelled ? "cancelled" : "failed",
            error: isCancelled ? undefined : message,
            logs: [...task.logs, makeLog(isCancelled ? "已中止" : `失败：${message}`, "info")],
          } : task));
          await refreshArchived();
        }
      }
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
    }
  }, [config, refreshArchived]);

  const clearFinished = () => {
    setTasks((current) => current.filter((task) => task.status === "queued" || task.status === "running"));
  };

  const cancelTask = useCallback(async (id: string) => {
    try {
      await invoke("cancel_task", { id });
    } catch (error) {
      setTasks((current) => current.map((task) => task.id === id ? {
        ...task,
        logs: [...task.logs, makeLog(`中止请求失败：${String(error)}`, "info")],
      } : task));
    }
  }, []);

  const updateTranslation = <K extends keyof TranslationConfig>(key: K, value: TranslationConfig[K]) => {
    setConfig((current) => ({
      ...current,
      translation: current.translation.map((t) =>
        t.id === activeTranslationId ? { ...t, [key]: value } : t
      ),
    }));
  };

  const createTranslation = useCallback(() => {
    const newId = crypto.randomUUID();
    const placeholder = defaultConfig.translation[0];
    const newCfg: TranslationConfig = {
      ...placeholder,
      id: newId,
      name: `配置 ${Date.now().toString(36).slice(-4)}`,
      apiKey: "",
      baseUrl: "",
      model: "",
    };
    setConfig((current) => ({ ...current, translation: [...current.translation, newCfg] }));
    setActiveTranslationId(newId);
  }, []);

  const deleteTranslation = useCallback((id: string) => {
    setConfig((current) => {
      if (current.translation.length <= 1) return current;
      const next = current.translation.filter((t) => t.id !== id);
      setActiveTranslationId((cur) => (cur === id ? (next[0]?.id ?? "") : cur));
      return { ...current, translation: next };
    });
  }, []);

  const switchTranslation = useCallback((id: string) => {
    setActiveTranslationId(id);
  }, []);

  const updateConfig = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className="app-shell">
      <aside className="side-panel">
        <div className="brand-block">
          <Logo className="brand-logo" onClick={handleLogoClick} />
          <p>本地视频字幕</p>
        </div>

        <nav className="rail-tabs" aria-label="主导航">
          <button className={activeTab === "queue" ? "active" : ""} onClick={() => setActiveTab("queue")}>任务列表</button>
          <button className={activeTab === "history" ? "active" : ""} onClick={() => setActiveTab("history")}>任务历史</button>
          <button className={activeTab === "api" ? "active" : ""} onClick={() => setActiveTab("api")}>翻译模型配置</button>
          <button className={activeTab === "model" ? "active" : ""} onClick={() => setActiveTab("model")}>ASR 模型与工具</button>
        </nav>

        <div className="status-card">
          <div className="status-row">
            <span>Whisper</span>
            <strong title={modelName}>{modelName}</strong>
          </div>
          <div className="status-row">
            <span>翻译模型</span>
            <strong title={activeTranslation?.model || "未配置"}>{activeTranslation?.model || "未配置"}</strong>
          </div>
        </div>

        {config.debug.enabled && (
          <div className="debug-entry-wrap">
            <button
              type="button"
              className="debug-entry on"
              onClick={() => setActiveTab("debug")}
            >
              <span className="debug-entry-dot" />
              <div>
                <strong>DEBUG 模式</strong>
                <p>已开启 · 点击进入</p>
              </div>
            </button>
            <button
              type="button"
              className="debug-entry-close"
              aria-label="关闭 DEBUG 模式"
              title="关闭 DEBUG 模式"
              onClick={() => setConfig((current) => ({ ...current, debug: { ...current.debug, enabled: false } }))}
            >×</button>
          </div>
        )}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title-row">
            <h2>{activeTab === "queue" ? "任务列表" : activeTab === "history" ? "任务历史" : activeTab === "api" ? "翻译模型配置" : activeTab === "model" ? "ASR 模型与工具" : "DEBUG 模式"}</h2>
            {sessionFailedTasks.length > 0 && (
              <button
                type="button"
                className="session-failed-badge"
                onClick={() => setShowFailedDialog(true)}
                title="点击查看本会话中失败的任务"
              >
                本会话 {sessionFailedTasks.length} 失败
              </button>
            )}
          </div>
          <div className="summary-strip">
            <span><b>{summary.queued}</b> 等待</span>
            <span><b>{summary.running}</b> 进行</span>
            <span><b>{summary.done}</b> 完成</span>
            <span><b>{summary.failed}</b> 失败</span>
            <span><b>{summary.cancelled}</b> 中止</span>
          </div>
        </header>

        {showFailedDialog && createPortal(
          <FailedTasksDialog
            tasks={sessionFailedTasks}
            logsByTaskId={logsByTaskId}
            onClose={() => setShowFailedDialog(false)}
          />,
          document.body,
        )}

        {debugEntryConfirm && createPortal(
          <ConfirmDialog
            title="DEBUG 模式"
            message="是否打开 DEBUG 模式设置页？将同时开启 DEBUG 模式（归档目录可自定义）。"
            confirmLabel="打开"
            onConfirm={() => {
              setConfig((current) => ({ ...current, debug: { ...current.debug, enabled: true } }));
              setActiveTab("debug");
            }}
            onClose={() => setDebugEntryConfirm(false)}
          />,
          document.body,
        )}

        {toast && createPortal(
          <div className="toast" role="status" aria-live="polite">{toast}</div>,
          document.body,
        )}

        {activeTab === "queue" && (
          <QueueView
            tasks={tasks}
            activeTask={activeTask}
            isProcessing={isProcessing}
            modelReady={Boolean(config.modelPath)}
            taskOptions={taskOptions}
            setTaskOptions={setTaskOptions}
            translations={config.translation}
            translationConfigured={translationConfigured}
            onTranslationTouched={() => { translationTouchedRef.current = true; }}
            chooseVideos={chooseVideos}
            startQueue={startQueue}
            clearFinished={clearFinished}
            onCancelTask={cancelTask}
          />
        )}

        {activeTab === "history" && (
          <HistoryView tasks={archivedTasks} onRefresh={refreshArchived} logsByTaskId={logsByTaskId} />
        )}

        {activeTab === "api" && (
          <ApiSettings
            config={config}
            translations={config.translation}
            activeTranslationId={activeTranslationId}
            onSwitch={switchTranslation}
            onCreate={createTranslation}
            onDelete={deleteTranslation}
            updateTranslation={updateTranslation}
          />
        )}

        {activeTab === "model" && (
          <ModelSettings
            config={config}
            updateConfig={updateConfig}
            chooseModel={chooseModel}
            chooseBinary={chooseBinary}
            checkTools={checkTools}
            toolStatus={toolStatus}
          />
        )}

        {activeTab === "debug" && (
          <DebugSettings
            config={config}
            setConfig={setConfig}
            updateDebug={(key, value) => setConfig((current) => ({ ...current, debug: { ...current.debug, [key]: value } }))}
            archivedTasks={archivedTasks}
            onRefreshArchived={refreshArchived}
            onCloseDebug={() => {
              setConfig((current) => ({ ...current, debug: { ...current.debug, enabled: false } }));
              setActiveTab("queue");
            }}
          />
        )}
      </section>
    </main>
  );
}

function QueueView(props: {
  tasks: QueueTask[];
  activeTask?: QueueTask;
  isProcessing: boolean;
  modelReady: boolean;
  taskOptions: TaskOptions;
  setTaskOptions: React.Dispatch<React.SetStateAction<TaskOptions>>;
  translations: TranslationConfig[];
  translationConfigured: boolean;
  onTranslationTouched: () => void;
  chooseVideos: () => void;
  startQueue: () => void;
  clearFinished: () => void;
  onCancelTask: (id: string) => void;
}) {
  const { tasks, activeTask } = props;
  const selectedVadOption = vadThresholdOptions.find((option) => option.value === props.taskOptions.vadThreshold) ?? vadThresholdOptions[1];
  const [logViewOpen, setLogViewOpen] = useState(false);
  useEffect(() => { setLogViewOpen(false); }, [activeTask?.id]);
  const visibleLogs = useMemo(
    () => (activeTask?.logs ?? []).filter((entry) => entry.level !== "debug").slice(-80),
    [activeTask?.logs],
  );
  const latestLog = useMemo(
    () => activeTask?.logs.filter((entry) => entry.level !== "debug").at(-1),
    [activeTask?.logs],
  );

  const handleTranslationToggle = (event: React.ChangeEvent<HTMLInputElement>) => {
    props.onTranslationTouched();
    const next = event.target.checked;
    if (next && !props.translationConfigured) {
      window.alert("尚未配置翻译 API，请先到『翻译模型配置』页填写 Base URL / API Key / Model。");
      return;
    }
    props.setTaskOptions((current) => ({ ...current, translationEnabled: next }));
  };

  const finishedCount = tasks.filter((task) => task.status === "done" || task.status === "failed").length;
  const queueTasks = tasks.filter((task) => task.status === "queued");
  const queueStats = {
    total: queueTasks.length,
    queued: queueTasks.filter((task) => task.status === "queued").length,
    done: queueTasks.filter((task) => task.status === "done").length,
    failed: queueTasks.filter((task) => task.status === "failed").length,
  };

  return (
    <div className="queue-layout">
      <section className="primary-card drop-zone">
        <div>
          <h3>添加视频</h3>
          <p>选择本地视频，生成同目录 <code>.srt</code>。</p>
        </div>
        {!props.modelReady && <p className="notice">先选择 whisper.cpp 模型。</p>}
        <div className="button-row">
          <button className="btn primary" onClick={props.chooseVideos}>添加视频</button>
          <button className="btn" disabled={!props.modelReady || props.isProcessing || tasks.every((task) => task.status !== "queued")} onClick={props.startQueue}>
            {props.isProcessing ? "处理中 · 新增自动接上" : "开始"}
          </button>
        </div>
        <div className="task-toggle-row">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={props.taskOptions.translationEnabled}
              onChange={handleTranslationToggle}
              disabled={!props.translationConfigured}
            />
            翻译/润色
          </label>
          <label className="field">
            <span>配置（{props.translationConfigured ? "随任务保存；关闭时只输出原文识别字幕。" : "请先到『翻译模型配置』页配置接口后再启用。"}）</span>
            <select
              value={props.taskOptions.translationConfigId}
              disabled={!props.translationConfigured || !props.taskOptions.translationEnabled}
              onChange={(event) => props.setTaskOptions((current) => ({ ...current, translationConfigId: event.target.value }))}
            >
              {props.translations.map((c) => (
                <option key={c.id} value={c.id}>{c.name || "(未命名)"}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="vad-task-options">
          <div className="vad-control">
            <label className="switch-row">
              <input
                type="checkbox"
                checked={props.taskOptions.vadEnabled}
                onChange={(event) => props.setTaskOptions((current) => ({ ...current, vadEnabled: event.target.checked }))}
              />
              VAD 人声检测
            </label>
            <label className="field">
              <span>阈值（{selectedVadOption.detail}）</span>
              <select
                value={props.taskOptions.vadThreshold}
                disabled={!props.taskOptions.vadEnabled}
                onChange={(event) => props.setTaskOptions((current) => ({ ...current, vadThreshold: Number(event.target.value) }))}
              >
                {vadThresholdOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <aside className="vad-guide" aria-label="VAD 使用说明">
            <p><strong>作用</strong>：过滤静音、音乐、掌声，减少幻觉字幕。</p>
            <p><strong>适合</strong>：长视频、访谈、演讲、重复字幕明显的素材。</p>
            <p><strong>策略</strong>：先用 0.50；漏字降到 0.30；噪声多升到 0.70。</p>
          </aside>
        </div>
      </section>

      <section className="queue-feed">
        <section className="queue-active">
          {logViewOpen && activeTask ? (
            <ActiveTaskLogView task={activeTask} entries={visibleLogs} onBack={() => setLogViewOpen(false)} />
          ) : (
            <ActiveTaskCard
              task={activeTask}
              latestLog={latestLog}
              onViewLog={activeTask ? () => setLogViewOpen(true) : undefined}
              onCancel={activeTask ? () => props.onCancelTask(activeTask.id) : undefined}
            />
          )}
        </section>

        <section className="task-list" aria-label="任务队列">
          <div className="task-list-head">
            <h3>任务队列</h3>
            <span className="panel-sub">{queueStats.queued} 等待</span>
          </div>
          {queueTasks.length === 0 && <div className="empty-state">任务队列为空</div>}
          {queueTasks.map((task) => (
            <article className={`task-card ${task.status}`} key={task.id}>
              <div>
                <strong>{task.videoPath.split(/[\\/]/).at(-1)}</strong>
                <span>{task.videoPath}</span>
              </div>
              <div className="task-meta">
                <StatusBadge status={task.status} />
                <span className="task-option-chip">{task.vadEnabled ? "VAD " + task.vadThreshold.toFixed(2) : "VAD 关闭"}</span>
                <span className="task-option-chip">{task.translationEnabled ? `翻译开 · ${task.translationConfigName ?? ""}` : "翻译关"}</span>
              </div>
              {task.outputPath && <p className="result-line">输出：{task.outputPath} · {task.subtitleCount} 条 · {task.usedSegments} 段</p>}
              {task.error && <p className="error-line">{task.error}</p>}
            </article>
          ))}
        </section>
      </section>
    </div>
  );
}

function LogLines({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) {
    return <p className="log-empty">等待任务</p>;
  }
  return (
    <>
      {entries.map((entry, index) => (
        <p key={`${index}-${entry.timestamp}`} className="log-line">
          <span
            className={`log-badge log-badge-${entry.category}`}
            title={formatLogTimestamp(entry.timestamp)}
          >
            {LOG_CATEGORY_LABELS[entry.category]}
          </span>
          <span className="log-text">{entry.message}</span>
        </p>
      ))}
    </>
  );
}

function LogDetailDialog({ taskName, entries, onClose }: { taskName: string; entries: LogEntry[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const text = entries
      .map((entry) => `[${formatLogTimestamp(entry.timestamp)}] [${LOG_CATEGORY_LABELS[entry.category]}] ${entry.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      window.alert(`复制失败：${String(error)}`);
    }
  };
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog log-detail-dialog" role="dialog" aria-label="详细日志" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>详细日志 · {taskName}</h3>
          <div className="log-detail-head-actions">
            <button type="button" className="btn quiet small" onClick={handleCopy}>
              {copied ? "已复制" : "复制日志"}
            </button>
            <button className="info-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="modal-body log-detail-body">
          {entries.length === 0 ? (
            <p className="log-empty">无日志记录</p>
          ) : (
            <div className="log-detail-stream">
              {entries.map((entry, index) => (
                <p key={`${index}-${entry.timestamp}`} className={`log-line log-line-${entry.level}`}>
                  <span className="log-detail-time">{formatLogTimestamp(entry.timestamp)}</span>
                  <span className={`log-badge log-badge-${entry.category}`}>{LOG_CATEGORY_LABELS[entry.category]}</span>
                  <span className="log-text">{entry.message}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FailedTasksDialog({ tasks, logsByTaskId, onClose }: {
  tasks: QueueTask[];
  logsByTaskId: Record<string, LogEntry[]>;
  onClose: () => void;
}) {
  const [logTask, setLogTask] = useState<{ name: string; entries: LogEntry[] } | null>(null);
  const sorted = useMemo(
    () => [...tasks].sort((a, b) => {
      const aT = a.logs.at(-1)?.timestamp ?? 0;
      const bT = b.logs.at(-1)?.timestamp ?? 0;
      return bT - aT;
    }),
    [tasks],
  );
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog failed-dialog" role="dialog" aria-label="本会话失败任务" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>本会话失败任务 · {sorted.length}</h3>
          <button className="info-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body failed-list-body">
          {sorted.length === 0 ? (
            <p className="log-empty">无失败任务</p>
          ) : sorted.map((task) => {
            const videoName = task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath;
            const lastTs = task.logs.at(-1)?.timestamp;
            return (
              <article key={task.id} className="task-card failed failed-list-item">
                <div className="failed-list-main">
                  <div className="failed-list-head">
                    <StatusBadge status="failed" />
                    <strong>{videoName}</strong>
                    {lastTs && <span className="history-time">{formatLogTimestamp(lastTs)}</span>}
                  </div>
                  <p className="path-line">{task.videoPath}</p>
                  {task.error && <p className="error-line">{task.error}</p>}
                </div>
                <div className="failed-list-actions">
                  {logsByTaskId[task.id] && logsByTaskId[task.id].length > 0 && (
                    <button
                      type="button"
                      className="btn quiet small"
                      onClick={() => setLogTask({ name: videoName, entries: logsByTaskId[task.id] })}
                    >
                      任务日志
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {logTask && (
        <LogDetailDialog
          taskName={logTask.name}
          entries={logTask.entries}
          onClose={() => setLogTask(null)}
        />
      )}
    </div>,
    document.body,
  );
}

function ActiveTaskCard({ task, latestLog, onViewLog, onCancel }: {
  task?: QueueTask;
  latestLog?: LogEntry;
  onViewLog?: () => void;
  onCancel?: () => void;
}) {
  if (!task) {
    return (
      <div className="active-task-card empty">
        <div className="active-empty">
          <span>当前任务</span>
          <strong>暂无任务处理中</strong>
          <p>选择视频后点『开始』启动队列。</p>
        </div>
      </div>
    );
  }
  const fileName = task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath;
  const stage = task.error
    ? `错误：${task.error}`
    : task.outputPath
      ? `输出：${task.outputPath} · ${task.subtitleCount} 条 · ${task.usedSegments} 段`
      : (latestLog?.message ?? "处理中");
  return (
    <div className={`active-task-card ${task.status}`}>
      <div className="active-task-head">
        <StatusBadge status={task.status} />
        <div className="active-task-actions">
          {onViewLog && (
            <button type="button" className="viewlog-btn" onClick={onViewLog} aria-label="查看运行日志">
              运行日志 →
            </button>
          )}
          {onCancel && task.status === "running" && (
            <button type="button" className="cancel-btn" onClick={onCancel} aria-label="中止当前任务">
              中止
            </button>
          )}
        </div>
      </div>
      <div className="active-task-chips">
        <span className="task-option-chip">{task.vadEnabled ? `VAD ${task.vadThreshold.toFixed(2)}` : "VAD 关闭"}</span>
        <span className="task-option-chip">{task.translationEnabled ? `翻译开 · ${task.translationConfigName ?? ""}` : "翻译关"}</span>
      </div>
      <div className="active-task-title" title={task.videoPath}>
        <strong>{fileName}</strong>
      </div>
      <progress value={task.progress} max={1} />
      <p className={`active-stage ${task.error ? "bad" : ""}`}>{stage}</p>
    </div>
  );
}

function ActiveTaskLogView({ task, entries, onBack }: {
  task: QueueTask;
  entries: LogEntry[];
  onBack: () => void;
}) {
  const fileName = task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath;
  return (
    <div className={`active-task-card log-view ${task.status}`}>
      <div className="active-log-head">
        <button type="button" className="active-log-back" onClick={onBack} aria-label="返回">
          ← 返回
        </button>
        <strong className="active-log-subtitle" title={fileName}>{fileName}</strong>
      </div>
      <div className="log-stream">
        <LogLines entries={entries} />
      </div>
    </div>
  );
}

function ApiSettings({ config, translations, activeTranslationId, onSwitch, onCreate, onDelete, updateTranslation }: {
  config: AppConfig;
  translations: TranslationConfig[];
  activeTranslationId: string;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  updateTranslation: <K extends keyof TranslationConfig>(key: K, value: TranslationConfig[K]) => void;
}) {
  const t = translations.find((c) => c.id === activeTranslationId) ?? translations[0];
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestTranslationResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [modelFetching, setModelFetching] = useState(false);

  useEffect(() => {
    if (!t.baseUrl.trim() || !t.apiKey.trim()) {
      setModels([]);
      setModelFetchError(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setModelFetching(true);
      try {
        const list = await invoke<string[]>("fetch_translation_models", { config: t });
        if (cancelled) return;
        setModels(list);
        setModelFetchError(null);
      } catch (error) {
        if (cancelled) return;
        setModels([]);
        setModelFetchError(String(error));
      } finally {
        if (!cancelled) setModelFetching(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [t.baseUrl, t.apiKey]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<TestTranslationResult>("test_translation", { config: t });
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, latencyMs: 0, sampleInput: "", sampleOutput: "", message: `失败 · ${String(error)}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-grid api-layout">
      <section className="form-card api-config-card">
        <div className="api-config-head">
          <h3>API 配置</h3>
          <div className="api-config-switcher">
            <select value={activeTranslationId} onChange={(event) => onSwitch(event.target.value)} aria-label="切换翻译配置">
              {translations.map((c) => (
                <option key={c.id} value={c.id}>{c.name || "(未命名)"}</option>
              ))}
            </select>
            <button type="button" className="btn quiet small" onClick={onCreate} title="新建配置">＋</button>
            <button
              type="button"
              className="btn quiet small"
              onClick={() => onDelete(activeTranslationId)}
              disabled={translations.length <= 1}
              title="删除当前配置"
            >删除</button>
          </div>
        </div>
        <Field label="配置名称" value={t.name} onChange={(value) => updateTranslation("name", value)} placeholder="给这份配置起个名字" />
        <Field label="Base URL" value={t.baseUrl} onChange={(value) => updateTranslation("baseUrl", value)} placeholder="https://api.openai.com/v1" />
        <Field label="API Key" value={t.apiKey} type="password" onChange={(value) => updateTranslation("apiKey", value)} placeholder="sk-..." />
        <label className="field">
          <span className="field-label-row">
            Model
            {modelFetching && <em className="field-hint">拉取中…</em>}
            {!modelFetching && modelFetchError && <em className="field-hint bad">自动获取 MODEL 失败，请手动输入</em>}
          </span>
          <input
            list="translation-models"
            value={t.model}
            placeholder="gpt-4.1-mini"
            onChange={(event) => updateTranslation("model", event.target.value)}
          />
          <datalist id="translation-models">
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
        <Field label="目标语言" value={t.targetLanguage} onChange={(value) => updateTranslation("targetLanguage", value)} placeholder="简体中文 / English / 日本語" />
        <div className="two-col">
          <NumberField label="Temperature" value={t.temperature} step={0.1} min={0} max={2} onChange={(value) => updateTranslation("temperature", value)} />
          <NumberField label="Batch size" value={t.batchSize} min={1} max={80} onChange={(value) => updateTranslation("batchSize", value)} />
        </div>
        <NumberField label="Timeout seconds" value={t.timeoutSeconds} min={10} max={600} onChange={(value) => updateTranslation("timeoutSeconds", value)} />
        <div className="button-row">
          <button className="btn primary" disabled={testing} onClick={runTest}>
            {testing ? "测试中…" : "测试"}
          </button>
        </div>
      </section>

      <section className="prompt-card">
        <h3>提示词</h3>
        <div className="prompt-field">
          <div className="prompt-label-row">
            <span>系统提示词</span>
            <button
              type="button"
              className="btn quiet small"
              disabled={t.systemPrompt === DEFAULT_SYSTEM_PROMPT}
              onClick={() => updateTranslation("systemPrompt", DEFAULT_SYSTEM_PROMPT)}
            >
              重置
            </button>
          </div>
          <textarea value={t.systemPrompt} onChange={(event) => updateTranslation("systemPrompt", event.target.value)} />
        </div>
        <div className="prompt-field">
          <div className="prompt-label-row">
            <span>用户提示词模板</span>
            <button
              type="button"
              className="btn quiet small"
              disabled={t.userTemplate === DEFAULT_USER_TEMPLATE}
              onClick={() => updateTranslation("userTemplate", DEFAULT_USER_TEMPLATE)}
            >
              重置
            </button>
          </div>
          <textarea value={t.userTemplate} onChange={(event) => updateTranslation("userTemplate", event.target.value)} />
        </div>
        <p className="notice">模板必须保留 <code>{"{items}"}</code>，应用会填入形如 <code>[12] 原字幕</code> 的批量字幕。</p>
      </section>

      {testResult && createPortal(
        <TestResultDialog result={testResult} onClose={() => setTestResult(null)} />,
        document.body,
      )}
    </div>
  );
}

function TestResultDialog({ result, onClose }: { result: TestTranslationResult; onClose: () => void }) {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" role="dialog" aria-label="测试结果" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>测试结果</h3>
          <button className="info-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className={`test-status ${result.ok ? "ok" : "bad"}`}>{result.message}</p>
          <label className="field">
            <span>输入</span>
            <pre className="test-pre">{result.sampleInput || "(无)"}</pre>
          </label>
          {result.ok && (
            <label className="field">
              <span>输出</span>
              <pre className="test-pre">{result.sampleOutput || "(无)"}</pre>
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function HistoryView({ tasks, onRefresh, logsByTaskId }: { tasks: ArchivedTask[]; onRefresh: () => Promise<void>; logsByTaskId: Record<string, LogEntry[]> }) {
  const [logTask, setLogTask] = useState<{ name: string; entries: LogEntry[] } | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [editingTask, setEditingTask] = useState<ArchivedTask | null>(null);
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => Promise<void> | void } | null>(null);
  const [alertState, setAlertState] = useState<string | null>(null);

  const settledTasks = useMemo(() => tasks.filter((task) => task.status !== "running"), [tasks]);

  const filtered = useMemo(() => {
    if (filter === "all") return settledTasks;
    return settledTasks.filter((task) => task.status === filter);
  }, [settledTasks, filter]);

  const stats = useMemo(() => ({
    total: settledTasks.length,
    done: settledTasks.filter((task) => task.status === "done").length,
    failed: settledTasks.filter((task) => task.status === "failed").length,
    cancelled: settledTasks.filter((task) => task.status === "cancelled").length,
  }), [settledTasks]);

  const handleClear = () => {
    const ids = filtered.map((task) => task.id);
    if (ids.length === 0) return;
    setConfirmState({
      title: "清理任务",
      message: `确认清理当前筛选下的 ${ids.length} 个任务？该操作会删除对应的归档文件夹，但不会影响视频和已生成的 srt 文件。`,
      confirmLabel: "清理",
      onConfirm: async () => {
        try {
          await invoke("delete_archived_tasks", { ids });
          await onRefresh();
        } catch (error) {
          setAlertState(`清理失败：${String(error)}`);
        }
      },
    });
  };

  const handleReveal = async (task: ArchivedTask) => {
    try {
      await invoke("open_in_folder", { path: task.videoPath });
    } catch (error) {
      setAlertState(`打开失败：${String(error)}`);
    }
  };

  return (
    <div className="history-layout">
      <section className="task-list history-list" aria-label="任务历史">
        <div className="task-list-head">
          <h3>任务历史</h3>
          <div className="history-actions">
            <div className="segmented small">
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 {stats.total}</button>
              <button className={filter === "done" ? "active" : ""} onClick={() => setFilter("done")}>成功 {stats.done}</button>
              <button className={filter === "failed" ? "active" : ""} onClick={() => setFilter("failed")}>失败 {stats.failed}</button>
              <button className={filter === "cancelled" ? "active" : ""} onClick={() => setFilter("cancelled")}>已中止 {stats.cancelled}</button>
            </div>
            <button className="btn quiet small" disabled={filtered.length === 0} onClick={handleClear}>清理任务</button>
          </div>
        </div>
        {filtered.length === 0 && <div className="empty-state">无符合条件的任务</div>}
        {filtered.map((task) => (
          <HistoryTaskCard
            key={task.id}
            task={task}
            logs={logsByTaskId[task.id]}
            onReveal={() => handleReveal(task)}
            onEdit={() => setEditingTask(task)}
            onShowLog={(entries) => setLogTask({ name: task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath, entries })}
          />
        ))}
      </section>

      {confirmState && createPortal(
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={() => { void confirmState.onConfirm(); }}
          onClose={() => setConfirmState(null)}
        />,
        document.body,
      )}

      {editingTask && createPortal(
        <SubtitleEditorDialog task={editingTask} onClose={() => setEditingTask(null)} onSaved={onRefresh} />,
        document.body,
      )}

      {logTask && createPortal(
        <LogDetailDialog
          taskName={logTask.name}
          entries={logTask.entries}
          onClose={() => setLogTask(null)}
        />,
        document.body,
      )}

      {alertState && createPortal(
        <ConfirmDialog
          title="提示"
          message={alertState}
          confirmLabel="知道了"
          hideCancel
          onConfirm={() => setAlertState(null)}
          onClose={() => setAlertState(null)}
        />,
        document.body,
      )}
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel = "确认", cancelLabel = "取消", hideCancel = false, onConfirm, onClose }: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog confirm-dialog" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="info-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="confirm-message">{message}</p>
        </div>
        <div className="modal-foot">
          {!hideCancel && <button className="btn quiet" onClick={onClose}>{cancelLabel}</button>}
          <button className="btn primary" onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function HistoryTaskCard({ task, logs, onReveal, onEdit, onShowLog }: {
  task: ArchivedTask;
  logs?: LogEntry[];
  onReveal: () => void;
  onEdit: () => void;
  onShowLog: (entries: LogEntry[]) => void;
}) {
  const videoName = task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath;
  const createdAt = formatTimestamp(task.createdAt);
  return (
    <article className={`task-card history-task-card ${task.status}`}>
      <div className="history-task-main">
        <div className="history-task-head">
          <StatusBadge status={task.status} />
          <strong>{videoName}</strong>
          <span className="history-time">{createdAt}</span>
        </div>
        <div className="history-task-paths">
          <p><span>视频</span><code>{task.videoPath}</code></p>
          <p><span>SRT</span><code>{task.outputPath || "—"}</code></p>
        </div>
        <div className="history-task-meta">
          <span className="task-option-chip">{task.vadEnabled ? `VAD ${task.vadThreshold.toFixed(2)}` : "VAD 关闭"}</span>
          <span className="task-option-chip">{task.translationEnabled ? `翻译开 · ${task.translationConfigName ?? "（历史任务）"}` : "翻译关"}</span>
          <span className="task-option-chip">{task.subtitleCount} 条字幕</span>
          {task.usedSegments > 0 && <span className="task-option-chip">{task.usedSegments} 段</span>}
        </div>
        {task.status === "cancelled" ? (
          <p className="cancel-line">用户已中止</p>
        ) : task.error ? (
          <p className="error-line">{task.error}</p>
        ) : null}
      </div>
      <div className="history-task-actions">
        <button className="btn quiet small" disabled={!task.outputPath} onClick={onReveal}>显示文件</button>
        <button className="btn small" disabled={task.status !== "done"} onClick={onEdit}>字幕编辑</button>
        {logs && logs.length > 0 && (
          <button className="btn quiet small" onClick={() => onShowLog(logs)}>任务日志</button>
        )}
      </div>
    </article>
  );
}

function SubtitleEditorDialog({ task, onClose, onSaved }: { task: ArchivedTask; onClose: () => void; onSaved: () => Promise<void> }) {
  const [records, setRecords] = useState<SubtitleRecords | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasTranslation = task.translationEnabled;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await invoke<SubtitleRecords>("read_task_subtitles", { id: task.id });
        if (!cancelled) setRecords(data);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [task.id]);

  const updateEntry = (index: number, field: "text" | "translated", value: string) => {
    setRecords((current) => {
      if (!current) return current;
      return {
        entries: current.entries.map((entry) => entry.index === index ? { ...entry, [field]: value } : entry),
      };
    });
  };

  const handleSave = async () => {
    if (!records) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_task_subtitles", { id: task.id, records });
      await onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const videoName = task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog subtitle-editor" role="dialog" aria-label="字幕编辑" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>字幕编辑 · {videoName}</h3>
          <button className="info-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body subtitle-editor-body">
          {loading && <p className="notice">加载中…</p>}
          {error && <p className="error-line">{error}</p>}
          {records && (
            <div className="subtitle-grid">
              <div className="subtitle-grid-head">
                <span>原文{hasTranslation ? "" : "（最终 srt 内容）"}</span>
                {hasTranslation && <span>翻译（最终 srt 内容）</span>}
              </div>
              <div className="subtitle-grid-rows">
                {records.entries.map((entry) => (
                  <div className="subtitle-row" key={entry.index}>
                    <div className="subtitle-row-meta">
                      <span>#{entry.index}</span>
                      <code>{formatSrtTime(entry.start)} → {formatSrtTime(entry.end)}</code>
                    </div>
                    <div className={`subtitle-row-body ${hasTranslation ? "two-col" : "one-col"}`}>
                      <textarea
                        value={entry.text}
                        onChange={(event) => updateEntry(entry.index, "text", event.target.value)}
                        rows={2}
                      />
                      {hasTranslation && (
                        <textarea
                          value={entry.translated ?? ""}
                          placeholder="（未翻译）"
                          onChange={(event) => updateEntry(entry.index, "translated", event.target.value)}
                          rows={2}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="modal-foot-hint">保存后将同名覆盖 {task.outputPath ? task.outputPath.split(/[\\/]/).at(-1) : "srt"}</span>
          <button className="btn quiet" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!records || saving} onClick={handleSave}>
            {saving ? "保存中…" : "保存并重新生成 srt"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function ModelSettings(props: {
  config: AppConfig;
  updateConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
  chooseModel: () => void;
  chooseBinary: (key: "ffmpegPath" | "ffprobePath" | "whisperPath") => void;
  checkTools: () => void;
  toolStatus: ToolStatus | null;
}) {
  const { config, updateConfig } = props;
  const [showModelInfo, setShowModelInfo] = useState(false);
  const modelReady = Boolean(config.modelPath);
  return (
    <div className="model-layout">
      <section className="primary-card model-config-card">
        <div className="card-title-row">
          <h3>Whisper 模型</h3>
          <button className="info-button" type="button" aria-label="查看模型推荐" onClick={() => setShowModelInfo((value) => !value)}>i</button>
        </div>
        <p>推荐 <code>large-v3-turbo</code>。点击右上角
          <button
            type="button"
            className="info-button inline"
            aria-label="查看模型推荐"
            onClick={() => setShowModelInfo(true)}
          >i</button>
          查看模型推荐，下载完成后手动指定模型文件。
        </p>
        <div className="button-row">
          <button className="btn primary" onClick={props.chooseModel}>选择模型文件</button>
          <button className="btn" onClick={props.checkTools}>检查工具</button>
        </div>
        <p className="path-line">{config.modelPath || "尚未选择模型文件"}</p>

        <fieldset className="model-options" disabled={!modelReady} aria-disabled={!modelReady}>
          <SelectField label="语言" value={config.language} options={languageOptions} onChange={(value) => updateConfig("language", value)} disabled={!modelReady} />
          <div className="two-col">
            <NumberField label="分段阈值（分钟）" value={config.segmentThresholdMinutes} min={1} max={240} onChange={(value) => updateConfig("segmentThresholdMinutes", Math.round(value))} disabled={!modelReady} />
            <NumberField label="每段长度（分钟）" value={config.segmentMinutes} min={1} max={60} onChange={(value) => updateConfig("segmentMinutes", Math.round(value))} disabled={!modelReady} />
          </div>
          <NumberField label="重叠秒数" value={config.overlapSeconds} min={0} max={30} onChange={(value) => updateConfig("overlapSeconds", Math.round(value))} disabled={!modelReady} />
          <label className="switch-row">
            <input type="checkbox" checked={config.autoSegment} disabled={!modelReady} onChange={(event) => updateConfig("autoSegment", event.target.checked)} />
            超过阈值自动分段
          </label>
        </fieldset>
      </section>

      <section className="form-card tool-card">
        <ToolPath label="ffmpeg" value={config.ffmpegPath} onChoose={() => props.chooseBinary("ffmpegPath")} />
        <ToolPath label="ffprobe" value={config.ffprobePath} onChoose={() => props.chooseBinary("ffprobePath")} />
        <ToolPath label="whisper-cli" value={config.whisperPath} onChoose={() => props.chooseBinary("whisperPath")} />
        <ToolStatusView status={props.toolStatus} />
      </section>

      {showModelInfo && createPortal(
        <div className="modal-overlay" onClick={() => setShowModelInfo(false)}>
          <div className="model-info-dialog" role="dialog" aria-label="模型推荐" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>模型推荐</h3>
              <button className="info-button" type="button" aria-label="关闭" onClick={() => setShowModelInfo(false)}>×</button>
            </div>
            <div className="model-info-grid">
              <ModelCard name="large-v3-turbo" tag="推荐" detail="速度和准确率折中最好，适合多数视频字幕。" />
              <ModelCard name="medium" tag="省资源" detail="体积更小，速度更快，复杂口音/噪声下准确率弱一些。" />
              <ModelCard name="large-v3" tag="高准确率" detail="更慢更大，适合追求准确率且机器配置较好的用户。" />
              <ModelCard name="q5_0 / q8_0" tag="量化" detail="体积更小或推理更轻，准确率可能略有损失。" />
            </div>
            <div className="model-info-foot">
              <p>从 Hugging Face 下载 <code>ggml-*.bin</code> 后，回到本页『选择模型文件』。</p>
              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  invoke("open_url", { url: "https://huggingface.co/ggerganov/whisper.cpp/tree/main" }).catch((error) => window.alert(`打开失败：${String(error)}`));
                }}
              >
                打开 Hugging Face
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function DebugSettings({ config, setConfig, updateDebug, archivedTasks, onRefreshArchived, onCloseDebug }: {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  updateDebug: <K extends keyof DebugConfig>(key: K, value: DebugConfig[K]) => void;
  archivedTasks: ArchivedTask[];
  onRefreshArchived: () => Promise<void>;
  onCloseDebug: () => void;
}) {
  const d = config.debug;
  const [showInfo, setShowInfo] = useState(false);
  const [overview, setOverview] = useState<{ rootPath: string; settingsExists: boolean; settingsSize: number; tasksCount: number } | null>(null);
  const [settingsContent, setSettingsContent] = useState<string | null>(null);
  const [settingsJson, setSettingsJson] = useState<string>("");
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const settingsTaRef = useRef<HTMLTextAreaElement>(null);
  const settingsSaveTimerRef = useRef<number | null>(null);

  const refreshOverview = useCallback(async () => {
    try {
      const data = await invoke<{ rootPath: string; settingsExists: boolean; settingsSize: number; tasksCount: number }>("archive_overview");
      setOverview(data);
    } catch (error) {
      console.warn("archive_overview failed:", error);
    }
  }, []);

  const refreshSettingsContent = useCallback(async () => {
    try {
      const text = await invoke<string | null>("read_settings_file");
      setSettingsContent(text);
      if (text != null) setSettingsJson(text);
    } catch (error) {
      console.warn("read_settings_file failed:", error);
      setSettingsContent(null);
    }
  }, []);

  useEffect(() => {
    refreshOverview();
    refreshSettingsContent();
  }, [refreshOverview, refreshSettingsContent, archivedTasks]);

  useEffect(() => {
    const ta = settingsTaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [settingsJson, settingsExpanded]);

  const handleSettingsEdit = (value: string) => {
    setSettingsJson(value);
    setSettingsError(null);
    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    settingsSaveTimerRef.current = window.setTimeout(() => {
      try {
        const parsed = JSON.parse(value) as Partial<AppConfig>;
        const parsedTranslation = Array.isArray(parsed.translation) ? parsed.translation : [];
        setConfig((current) => ({
          ...current,
          ...parsed,
          translation: parsedTranslation.length > 0
            ? parsedTranslation.map((t) => ({
                ...defaultConfig.translation[0],
                ...t,
                id: t.id || crypto.randomUUID(),
              }))
            : current.translation,
          debug: current.debug,
        }));
        setSettingsSaved(true);
        window.setTimeout(() => setSettingsSaved(false), 1200);
      } catch (error) {
        setSettingsError(String(error));
      }
    }, 600);
  };

  const effectivePath = (() => {
    if (!d.enabled) return "~/.sayiiwhat（默认）";
    const trimmed = d.archiveRoot.trim().replace(/[/\\]+$/, "");
    if (!trimmed) return "~/.sayiiwhat（默认）";
    if (/[\\/]\.sayiiwhat$/.test(trimmed)) return trimmed;
    return `${trimmed}/.sayiiwhat`;
  })();
  const chooseArchiveRoot = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      updateDebug("archiveRoot", selected);
    }
  };
  return (
    <div className="debug-layout">
      <section className="primary-card debug-config-card">
        <div className="card-title-row">
          <h3>DEBUG 模式</h3>
          <div className="debug-title-actions">
            <button type="button" className="btn quiet small" onClick={onCloseDebug}>关闭 DEBUG 模式</button>
            <button className="info-button" type="button" aria-label="关于 DEBUG 模式" onClick={() => setShowInfo(true)}>i</button>
          </div>
        </div>
        <div className="debug-toggle-row">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={d.enabled}
              onChange={(event) => updateDebug("enabled", event.target.checked)}
            />
            开启 DEBUG 模式
          </label>
          <p>关闭时所有任务归档走默认路径（~/.sayiiwhat），不影响日常使用。开启后可自定义归档目录，适合开发机/调试场景：旧的归档保留不动，新归档会写入到指定路径。注意：生效目录里的 <code>settings.json</code>（含 base URL / API key 等配置）会作为当前配置读写；已配置好的 apiKey / baseUrl / model 不会被空值覆盖，但切换到一个全新的空目录时，需要在那里重新填写一次配置。</p>
        </div>
        <label className="field">
          <span>.sayiiwhat 父目录</span>
          <div className="debug-path-input">
            <input
              value={d.archiveRoot}
              placeholder="留空使用默认 ~/  →  ~/.sayiiwhat"
              onChange={(event) => updateDebug("archiveRoot", event.target.value)}
              disabled={!d.enabled}
            />
            <button
              type="button"
              className="btn quiet small"
              disabled={!d.enabled}
              onClick={chooseArchiveRoot}
            >
              选择目录
            </button>
          </div>
        </label>
        <p className="notice">当前生效路径：<code>{effectivePath}</code></p>

        {showInfo && createPortal(
          <div className="modal-overlay" onClick={() => setShowInfo(false)}>
            <div className="model-info-dialog" role="dialog" aria-label="关于 DEBUG 模式" onClick={(event) => event.stopPropagation()}>
              <div className="modal-head">
                <h3>关于 DEBUG 模式</h3>
                <button className="info-button" type="button" aria-label="关闭" onClick={() => setShowInfo(false)}>×</button>
              </div>
              <div className="modal-body debug-info-body">
                <p><strong>为什么有 DEBUG 模式？</strong></p>
                <p>同一台机器同时承担"日常使用"和"开发调试"时，正常模式的任务归档会写入 <code>~/.sayiiwhat/</code>，开发测试产生的脏数据会污染日常使用的数据。DEBUG 模式允许你指定一个独立的父目录（比如 <code>~/dev/sayiiwhat-test/</code>），新归档会写到 <code>~/dev/sayiiwhat-test/.sayiiwhat/</code>，与日常数据完全隔离。配置文件本身始终在系统标准位置，DEBUG 开关也写在那里，所以切换不会丢失。</p>
                <p><strong>如何关闭？</strong></p>
                <p>点击左上角 Logo <strong>8 次</strong>即可关闭 DEBUG 模式（同时归档目录切回默认 <code>~/.sayiiwhat</code>）。第 4 次起会有 toast 提示剩余次数。也可以直接关闭本页的『开启 DEBUG 模式』开关——区别是 Logo 入口会同时切回任务列表 tab。</p>
                <p><strong>DEBUG 状态存在哪？</strong></p>
                <p>DEBUG 开关（enabled / archiveRoot）存于 Tauri 标准 app config 目录（<code>~/Library/Application Support/com.morphiiouo.sayiiwhat/config.json</code>），不在 <code>.sayiiwhat/</code> 中，避免循环依赖。</p>
              </div>
              <div className="modal-foot">
                <button className="btn primary" onClick={() => setShowInfo(false)}>知道了</button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      </section>

      <section className="task-list debug-archive-list" aria-label="归档目录内容">
        <div className="task-list-head">
          <div>
            <h3>归档目录内容</h3>
            <p>{overview ? `${overview.tasksCount} 个任务 · ${overview.settingsExists ? "1 配置文件" : "无配置文件"}` : "加载中…"}</p>
          </div>
          <div className="history-actions">
            <button type="button" className="btn quiet small" onClick={() => { void onRefreshArchived(); void refreshOverview(); void refreshSettingsContent(); }}>刷新</button>
          </div>
        </div>

        {overview && (
          <div className="debug-overview">
            <p><span>路径</span><code>{overview.rootPath}</code></p>
          </div>
        )}

        <article className={`task-card debug-file-card ${overview?.settingsExists ? "" : "missing"}`}>
          <div className="failed-list-head">
            <span className="task-option-chip">配置</span>
            <strong>settings.json</strong>
            {overview && <span className="history-time">{overview.settingsExists ? `${overview.settingsSize} B` : "缺失"}</span>}
          </div>
          <p className="path-line">主配置（不含 DEBUG 开关，与各 tab 字段一致）</p>
          <div className="history-task-actions">
            <span className="debug-edit-hint">
              {settingsError
                ? <em className="bad">JSON 错误：{settingsError}</em>
                : settingsSaved
                  ? <em className="ok">已保存</em>
                  : settingsExpanded
                    ? <em>编辑后自动保存</em>
                    : null}
            </span>
            <button
              type="button"
              className="btn quiet small"
              disabled={!overview?.settingsExists}
              onClick={() => setSettingsExpanded((v) => !v)}
            >
              {settingsExpanded ? "收起" : "查看内容"}
            </button>
          </div>
          {settingsExpanded && settingsContent != null && (
            <textarea
              ref={settingsTaRef}
              className="debug-json-editor"
              value={settingsJson}
              spellCheck={false}
              onChange={(event) => handleSettingsEdit(event.target.value)}
            />
          )}
        </article>

        {archivedTasks.length === 0 ? (
          <div className="empty-state">归档目录为空</div>
        ) : archivedTasks.map((task) => {
          const videoName = task.videoPath.split(/[\\/]/).at(-1) ?? task.videoPath;
          const createdAt = formatTimestamp(task.createdAt);
          return (
            <article key={task.id} className={`task-card debug-task-card ${task.status}`}>
              <div className="failed-list-head">
                <StatusBadge status={task.status} />
                <strong>{videoName}</strong>
                <span className="history-time">{createdAt}</span>
              </div>
              <p className="path-line">{task.videoPath}</p>
              {task.outputPath && <p className="path-line">{task.outputPath}</p>}
              <div className="history-task-meta">
                <span className="task-option-chip">{task.vadEnabled ? `VAD ${task.vadThreshold.toFixed(2)}` : "VAD 关闭"}</span>
                <span className="task-option-chip">{task.translationEnabled ? `翻译开 · ${task.translationConfigName ?? "（历史任务）"}` : "翻译关"}</span>
                <span className="task-option-chip">{task.subtitleCount} 条字幕</span>
                {task.usedSegments > 0 && <span className="task-option-chip">{task.usedSegments} 段</span>}
              </div>
              {task.error && <p className="error-line">{task.error}</p>}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const labels: Record<TaskStatus, string> = {
    queued: "等待",
    running: "处理中",
    cancelled: "已中止",
    done: "完成",
    failed: "失败",
  };
  return <span className={`badge ${status}`}>{labels[status]}</span>;
}

function Field({ label, value, onChange, placeholder, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} type={type} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1, disabled = false }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} type="number" min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function SelectField({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, label]) => (
          <option value={optionValue} key={optionValue}>{label}</option>
        ))}
      </select>
    </label>
  );
}

function ToolPath({ label, value, onChoose }: { label: string; value: string; onChoose: () => void }) {
  return (
    <div className="tool-path">
      <div>
        <span>{label}</span>
        <p>{value || "未设置，优先使用随包工具，其次使用 PATH"}</p>
      </div>
      <button className="btn quiet" onClick={onChoose}>选择</button>
    </div>
  );
}

function ToolStatusView({ status }: { status: ToolStatus | null }) {
  if (!status) return <p className="notice">点击“检查工具”查看 ffmpeg / ffprobe / whisper-cli 是否可用。</p>;
  const entries = Object.entries(status) as [keyof ToolStatus, ToolCheck][];
  const okCount = entries.filter(([, check]) => check.ok).length;
  const allOk = okCount === entries.length;
  return (
    <div className="tool-status">
      <div className="tool-status-banner">
        <span className={`tool-status-badge ${allOk ? "ok" : "bad"}`}>
          {allOk ? "全部就绪" : `${okCount}/${entries.length} 就绪`}
        </span>
        <span className="tool-status-banner-text">
          {allOk ? "ffmpeg / ffprobe / whisper-cli 均可调用，可直接开始处理任务。" : "部分工具缺失，请按提示手动选择路径或安装对应工具。"}
        </span>
      </div>
      <div className="tool-status-list">
        {entries.map(([name, check]) => (
          <article key={name} className={`tool-status-row ${check.ok ? "ok" : "bad"}`}>
            <div className="tool-status-head">
              <span className="tool-status-name">{name}</span>
              <span className={`tool-status-pill ${check.ok ? "ok" : "bad"}`}>
                {check.ok ? "已就绪" : "缺失"}
              </span>
            </div>
            {check.path && <p className="tool-status-path">{check.path}</p>}
            <p className="tool-status-message">{check.message}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function ModelCard({ name, tag, detail }: { name: string; tag: string; detail: string }) {
  return (
    <article>
      <span>{tag}</span>
      <h4>{name}</h4>
      <p>{detail}</p>
    </article>
  );
}

function appendGlobalLog(message: string) {
  console.warn(message);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
