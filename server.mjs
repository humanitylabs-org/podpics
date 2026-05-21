#!/usr/bin/env node
import http from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOST = process.env.PODPICS_HOST || '127.0.0.1';
const PORT = Number(process.env.PODPICS_PORT || 8792);
const BASE = '/podpics';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(ROOT, 'index.html');
const SCRIPT_PATH = path.join(ROOT, 'generate_test_timeline.py');
const SERVER_CONFIG_PATH = path.join(ROOT, 'podpics-server-config.json');
const LOCAL_WORKFLOW_FILENAME = 'podpics-user-workflow.json';
const TRANSCRIPT_HISTORY_FILENAME = 'podpics-transcript-findreplace-history.json';

const AGENT_WORKSPACE_ROOT = path.resolve(ROOT, '..', '..');
const TEAM_DEFAULT_ROOT = path.join(AGENT_WORKSPACE_ROOT, 'podpics-workspace');
const DEVICE_DEFAULT_ROOT = path.join(process.env.HOME || '/root', '.local', 'share', 'podpics');
const LEGACY_DROPBOX_ROOT = process.env.PODPICS_LEGACY_DROPBOX_ROOT || '';
const LEGACY_LOCAL_ROOT = path.join(ROOT, 'data-local');
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024; // 80MB
const LOCAL_STT_URL = process.env.PODPICS_LOCAL_STT_URL || 'http://127.0.0.1:9099/v1/audio/transcriptions';
const LOCAL_STT_MODEL = process.env.PODPICS_STT_MODEL || 'distil-large-v3';
const LOCAL_STT_LANGUAGE = process.env.PODPICS_STT_LANGUAGE || 'en';
const LOCAL_STT_PROMPT = process.env.PODPICS_STT_PROMPT || '';
const CLOUD_STT_URL = process.env.PODPICS_CLOUD_STT_URL || (process.env.OPENAI_API_KEY ? 'https://api.openai.com/v1/audio/transcriptions' : '');
const CLOUD_STT_KEY = process.env.PODPICS_CLOUD_STT_KEY || process.env.OPENAI_API_KEY || '';
const CLOUD_STT_MODEL = process.env.PODPICS_CLOUD_STT_MODEL || 'gpt-4o-transcribe';
const HAS_CLOUD_STT = !!(CLOUD_STT_URL && CLOUD_STT_KEY);
const DEFAULT_STT_URL = HAS_CLOUD_STT ? CLOUD_STT_URL : LOCAL_STT_URL;
const DEFAULT_STT_KEY = HAS_CLOUD_STT
  ? CLOUD_STT_KEY
  : (process.env.PODPICS_LOCAL_STT_KEY ? String(process.env.PODPICS_LOCAL_STT_KEY) : '');
const DEFAULT_STT_MODEL = HAS_CLOUD_STT ? CLOUD_STT_MODEL : LOCAL_STT_MODEL;
const STT_WINDOW_SECONDS = Math.max(6, Number(process.env.PODPICS_STT_WINDOW_SECONDS || 60));
const STT_OVERLAP_SECONDS = Math.max(0, Math.min(STT_WINDOW_SECONDS - 1, Number(process.env.PODPICS_STT_OVERLAP_SECONDS || 0)));
const STT_PROMPT_TAIL_CHARS = Math.max(120, Number(process.env.PODPICS_STT_PROMPT_TAIL_CHARS || 260));
const STT_USE_ROLLING_PROMPT = String(process.env.PODPICS_STT_ROLLING_PROMPT || '0').trim() === '1';
const STT_AUDIO_CHANNEL = String(process.env.PODPICS_STT_AUDIO_CHANNEL || 'left').trim().toLowerCase();
const STT_CHUNK_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.PODPICS_STT_CHUNK_MAX_ATTEMPTS || 3)));
const STT_CHUNK_TIMEOUT_MS = Math.max(15_000, Number(process.env.PODPICS_STT_CHUNK_TIMEOUT_MS || 120_000));
const STT_CHUNK_RETRY_BACKOFF_MS = Math.max(200, Number(process.env.PODPICS_STT_CHUNK_RETRY_BACKOFF_MS || 1200));
const IMAGE_SECTION_TIMEOUT_MS = Math.max(60_000, Number(process.env.PODPICS_IMAGE_SECTION_TIMEOUT_MS || 420_000));
const IMAGE_TASK_POLL_MS = Math.max(1000, Number(process.env.PODPICS_IMAGE_TASK_POLL_MS || 5000));
const IMAGE_REFERENCE_MAX = Math.max(1, Math.min(6, Number(process.env.PODPICS_IMAGE_REFERENCE_MAX || 4)));
const IMAGE_MAIN_SESSION_KEY = 'main';
const DEFAULT_SECTION_GAP_MAX_MINUTES = 1.2;
const DEFAULT_SECTION_GAP_MIN_MINUTES = 0.6;
const DEFAULT_SECTION_DURATION_MIN_SECONDS = 4;
const DEFAULT_SECTION_DURATION_MAX_SECONDS = 8;
const MAX_TRANSCRIPT_JOBS = 30;
const MAX_RECOMMENDATION_JOBS = 20;
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw');
const OPENCLAW_MEDIA_ROOT = path.join(OPENCLAW_HOME, 'media');

const CATEGORY_DIRS = {
  reference: '02_reference',
  philosopher: '03_philosopher',
  meme: '04_meme',
  evidence: '05_evidence',
};

const DEFAULT_PROMPTS = {
  reference_book: {
    label: 'Book / movie cover reference',
    category: 'reference',
    defaultCount: 2,
    prompt: 'Generate reference-cover visuals only when a specific title/franchise/book/movie is explicitly referenced; match recognizable composition cues.',
  },
  philosopher_glitch: {
    label: 'Philosopher glitch style',
    category: 'philosopher',
    defaultCount: 3,
    prompt: 'Generate glitch-style historical/philosopher visuals only when a real named thinker/historical figure is explicitly mentioned.',
  },
  meme_commentary: {
    label: 'Meme commentary',
    category: 'meme',
    defaultCount: 5,
    prompt: 'Generate meme-style commentary as the flexible default when no strict reference/philosopher/study trigger exists; keep humor sharp, topical, and host-aligned.',
  },
  evidence_support: {
    label: 'Evidence / chart support',
    category: 'evidence',
    defaultCount: 2,
    prompt: 'Generate evidence/chart support only when a concrete study, data point, measured comparison, health/science claim, or source-backed financial/political metric is referenced.',
  },
};

const DEFAULT_IMAGE_SYSTEM_PROMPT_TEMPLATE = [
  'Create ONE single podcast video overlay image.',
  'STRICT OUTPUT RULES (must all be true):',
  '- Output exactly ONE image, filling the full frame edge-to-edge as one scene.',
  '- Do NOT produce a collage, contact sheet, grid, mosaic, photo wall, multi-panel layout, comic strip, before/after split, side-by-side, or any 2x2 / 3x3 / 4-up arrangement.',
  '- Do NOT include thumbnails, borders dividing the canvas, or labeled sub-panels.',
  '- One subject, one composition, one background.',
  'Generation route: OpenClaw gateway tool `image_generate`.',
  'Requested provider/model: {{REQUESTED_MODEL}}',
  'Routed provider/model: {{ROUTED_MODEL}}',
  'Section title: {{SECTION_TITLE}}',
  'Image type: {{STYLE_LABEL}} ({{STYLE_KEY}})',
  'Type rule: {{TYPE_RULE}}',
  'Direction: {{DIRECTION}}',
  '{{REFERENCE_BLOCK}}',
  'Hard quality constraints: cinematic contrast, sharp details, readable central subject, avoid muddy low-detail outputs.',
  'Transcript context:',
  '{{TRANSCRIPT_SNIPPET}}',
  'Final reminder: produce ONE single full-frame image, not a collage or grid of variants.',
].join('\n');

const DEFAULT_SECTION_PLANNER_PROMPT_TEMPLATE = [
  'You are planning short-form podcast visual overlays from transcript lines.',
  'Return ONLY JSON in this exact schema: {"sections":[{"lineStart":12,"lineEnd":16,"title":"...","styleKey":"{{FIRST_STYLE_KEY}}","side":"left|right","prompt":"..."}]}',
  'Estimated transcript duration: {{DURATION_MINUTES}} minutes.',
  'Section spacing rules: strict trigger sections may be close together when the transcript contains close-together triggers. Use the minimum gap mainly for subjective meme/commentary sections.',
  'Create every strong trigger section you find, up to the safety cap of {{MAX_COUNT}} sections. The target count {{TARGET_COUNT}} is only a soft guide for meme/commentary density, not for strict triggers.',
  'Allowed styleKey values: {{STYLE_KEYS}}.',
  'Rules: spread sections across whole transcript, avoid overlap, each range 2-5 lines, prompts should be specific and visually descriptive.',
  'Calibration principle: the transcript text is the trigger. Do not force global style ratios. If the transcript mentions many philosophers/books/studies, create many corresponding images; if it mentions none, create none.',
  'Practical style cues:',
  '- evidence_support cues: CDC/NIH/FDA, trial, paper, research finding, study result, data claim, statistic, percentage, chartable comparison, concrete health/science claim, stock/market/congress-trading metric, or other source-backed measurable claim.',
  '- Evidence boundary: do NOT use evidence_support for generic questions, abstract claims, persuasion, authority talk, manipulation/certainty commentary, or the word "who" as a pronoun. If it would be a reaction meme instead of a receipt/chart/source card, use meme_commentary.',
  '- reference_book cues: explicit title/franchise/book/movie/show references (can be unquoted).',
  '- philosopher_glitch cues: named thinkers/historical figures/eras.',
  '- meme_commentary cues: debate/opinion/reactive commentary without a concrete source artifact.',
  'Priority policy: strict trigger styles beat density rules. Meme/commentary is the flexible filler for subjective ideas, jokes, strong opinions, emotional reactions, or abstract arguments without a concrete artifact/person/data trigger.',
  'Density policy: only meme_commentary is density-constrained. Add meme/commentary sections where the conversation has strong visual moments, but do not use memes to crowd out strict trigger sections.',
  'Strict style policy:',
  '- Use philosopher_glitch whenever the section explicitly mentions a real philosopher, historical figure, named thinker, or historical era/movement that can be visually personified.',
  '- Use reference_book whenever the section explicitly mentions a specific book, movie, show, franchise, article, poster, cover, or named cultural artifact that can be represented as a cover/screenshot/poster.',
  '- Use evidence_support whenever the section explicitly mentions a study, research result, institution/source, statistic, percentage, chartable comparison, concrete medical/scientific claim, concrete finance/politics metric, or source-backed data point.',
  '- If none of those strict conditions are met, default to meme_commentary.',
  '- In each section.prompt, start with `Type: <style label>.` then the concrete visual direction.',
  '',
  'Transcript lines (idx\ttc\ttext):',
  '{{TRANSCRIPT_LINES}}',
].join('\n');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mxf': 'application/mxf',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mxf', '.m4v']);

let serverConfigCache = null;
const transcriptJobs = new Map();
const recommendationJobs = new Map();
let imageGenerationQueue = Promise.resolve();

async function runImageGenerationSerial(fn) {
  const prev = imageGenerationQueue;
  let release = null;
  imageGenerationQueue = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    if (typeof release === 'function') release();
  }
}

function defaultWorkflowConfig() {
  return {
    transcript: {
      apiUrl: DEFAULT_STT_URL,
      apiKey: DEFAULT_STT_KEY,
      model: DEFAULT_STT_MODEL,
      language: LOCAL_STT_LANGUAGE,
      prompt: LOCAL_STT_PROMPT,
      responseFormat: 'verbose_json',
      windowSeconds: STT_WINDOW_SECONDS,
      overlapSeconds: STT_OVERLAP_SECONDS,
      audioChannel: STT_AUDIO_CHANNEL,
    },
    recommendations: {
      engine: 'heuristic', // heuristic | openclaw
      model: '', // gateway model id, optional
      sessionMode: 'ephemeral', // ephemeral | main
      sessionKey: 'agent:main:podpics-recommendations',
      thinking: 'off',
      customPrompt: DEFAULT_SECTION_PLANNER_PROMPT_TEMPLATE,
      sectionGapMaxMinutes: DEFAULT_SECTION_GAP_MAX_MINUTES,
      sectionGapMinMinutes: DEFAULT_SECTION_GAP_MIN_MINUTES,
      maxSections: 64,
      sectionDurationMinSeconds: DEFAULT_SECTION_DURATION_MIN_SECONDS,
      sectionDurationMaxSeconds: DEFAULT_SECTION_DURATION_MAX_SECONDS,
    },
    images: {
      engine: 'pool', // pool | openclaw
      model: 'openai/gpt-image-2', // image_generate provider/model override
      sessionMode: 'main', // ephemeral | main
      sessionKey: IMAGE_MAIN_SESSION_KEY,
      countPerSection: 2,
      size: '1024x1024',
      aspectRatio: '',
      systemPromptTemplate: DEFAULT_IMAGE_SYSTEM_PROMPT_TEMPLATE,
    },
  };
}

function normalizeWorkflowConfig(input = {}, fallback = defaultWorkflowConfig()) {
  const cfg = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : defaultWorkflowConfig();
  const out = defaultWorkflowConfig();

  const t = cfg.transcript && typeof cfg.transcript === 'object' ? cfg.transcript : {};
  const tb = base.transcript || {};
  out.transcript.apiUrl = String(t.apiUrl || tb.apiUrl || DEFAULT_STT_URL).trim() || DEFAULT_STT_URL;
  out.transcript.apiKey = String(t.apiKey ?? tb.apiKey ?? '').trim();
  out.transcript.model = String(t.model || tb.model || DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL;
  out.transcript.language = String(t.language || tb.language || LOCAL_STT_LANGUAGE).trim() || LOCAL_STT_LANGUAGE;
  out.transcript.prompt = String(t.prompt ?? tb.prompt ?? LOCAL_STT_PROMPT).trim();
  out.transcript.responseFormat = String(t.responseFormat || tb.responseFormat || 'verbose_json').trim() || 'verbose_json';
  const transcriptWindowRaw = Number(t.windowSeconds ?? tb.windowSeconds ?? STT_WINDOW_SECONDS);
  out.transcript.windowSeconds = Math.max(6, Number.isFinite(transcriptWindowRaw) ? transcriptWindowRaw : STT_WINDOW_SECONDS);
  const transcriptOverlapRaw = Number(t.overlapSeconds ?? tb.overlapSeconds ?? STT_OVERLAP_SECONDS);
  out.transcript.overlapSeconds = Math.max(0, Math.min(out.transcript.windowSeconds - 1, Number.isFinite(transcriptOverlapRaw) ? transcriptOverlapRaw : STT_OVERLAP_SECONDS));
  const transcriptAudioChannel = String(t.audioChannel ?? tb.audioChannel ?? STT_AUDIO_CHANNEL).trim().toLowerCase();
  out.transcript.audioChannel = (transcriptAudioChannel === 'right' || transcriptAudioChannel === 'r')
    ? 'right'
    : ((transcriptAudioChannel === 'mix' || transcriptAudioChannel === 'both') ? 'mix' : 'left');

  const r = cfg.recommendations && typeof cfg.recommendations === 'object' ? cfg.recommendations : {};
  const rb = base.recommendations || {};
  const recEngine = String(r.engine || rb.engine || 'heuristic').toLowerCase();
  out.recommendations.engine = recEngine === 'openclaw' ? 'openclaw' : 'heuristic';
  out.recommendations.model = String(r.model ?? rb.model ?? '').trim();
  const recSessionMode = String(r.sessionMode || rb.sessionMode || 'ephemeral').toLowerCase();
  out.recommendations.sessionMode = recSessionMode === 'main' ? 'main' : 'ephemeral';
  out.recommendations.sessionKey = String(r.sessionKey || rb.sessionKey || 'agent:main:podpics-recommendations').trim() || 'agent:main:podpics-recommendations';
  out.recommendations.thinking = String(r.thinking || rb.thinking || 'off').trim() || 'off';
  out.recommendations.customPrompt = String(r.customPrompt ?? rb.customPrompt ?? DEFAULT_SECTION_PLANNER_PROMPT_TEMPLATE).trim() || DEFAULT_SECTION_PLANNER_PROMPT_TEMPLATE;

  const recLegacyPerMinute = Number(r.sectionsPerMinute || rb.sectionsPerMinute || 0);
  const recLegacyEveryRaw = Number(r.sectionEveryMinutes ?? rb.sectionEveryMinutes ?? (recLegacyPerMinute > 0 ? (1 / recLegacyPerMinute) : 0));
  const recMaxGapRaw = Number(r.sectionGapMaxMinutes ?? rb.sectionGapMaxMinutes ?? (recLegacyEveryRaw > 0 ? recLegacyEveryRaw : DEFAULT_SECTION_GAP_MAX_MINUTES));
  out.recommendations.sectionGapMaxMinutes = Math.max(0.2, Math.min(30, Number.isFinite(recMaxGapRaw) && recMaxGapRaw > 0 ? recMaxGapRaw : DEFAULT_SECTION_GAP_MAX_MINUTES));

  const recMinGapRaw = Number(r.sectionGapMinMinutes ?? rb.sectionGapMinMinutes ?? DEFAULT_SECTION_GAP_MIN_MINUTES);
  out.recommendations.sectionGapMinMinutes = Math.max(
    0.1,
    Math.min(out.recommendations.sectionGapMaxMinutes, Number.isFinite(recMinGapRaw) && recMinGapRaw > 0 ? recMinGapRaw : DEFAULT_SECTION_GAP_MIN_MINUTES),
  );

  const recMaxSectionsRaw = Number(r.maxSections ?? rb.maxSections ?? 48);
  out.recommendations.maxSections = Math.max(1, Math.min(96, Number.isFinite(recMaxSectionsRaw) ? Math.round(recMaxSectionsRaw) : 48));

  const recMinDurRaw = Number(r.sectionDurationMinSeconds ?? rb.sectionDurationMinSeconds ?? DEFAULT_SECTION_DURATION_MIN_SECONDS);
  const recMaxDurRaw = Number(r.sectionDurationMaxSeconds ?? rb.sectionDurationMaxSeconds ?? DEFAULT_SECTION_DURATION_MAX_SECONDS);
  out.recommendations.sectionDurationMinSeconds = Math.max(1, Math.min(30, Number.isFinite(recMinDurRaw) ? recMinDurRaw : DEFAULT_SECTION_DURATION_MIN_SECONDS));
  out.recommendations.sectionDurationMaxSeconds = Math.max(out.recommendations.sectionDurationMinSeconds + 0.5, Math.min(60, Number.isFinite(recMaxDurRaw) ? recMaxDurRaw : DEFAULT_SECTION_DURATION_MAX_SECONDS));

  const i = cfg.images && typeof cfg.images === 'object' ? cfg.images : {};
  const ib = base.images || {};
  const imgEngine = String(i.engine || ib.engine || 'pool').toLowerCase();
  out.images.engine = imgEngine === 'openclaw' ? 'openclaw' : 'pool';
  out.images.model = String(i.model ?? ib.model ?? '').trim();
  out.images.sessionMode = 'main';
  out.images.sessionKey = IMAGE_MAIN_SESSION_KEY;
  out.images.countPerSection = Math.max(1, Math.min(6, Number(i.countPerSection || ib.countPerSection || 2)));
  out.images.size = String(i.size || ib.size || '1024x1024').trim() || '1024x1024';
  out.images.aspectRatio = String(i.aspectRatio || ib.aspectRatio || '').trim();
  const tpl = String(i.systemPromptTemplate ?? ib.systemPromptTemplate ?? DEFAULT_IMAGE_SYSTEM_PROMPT_TEMPLATE);
  out.images.systemPromptTemplate = tpl.trim() ? tpl : DEFAULT_IMAGE_SYSTEM_PROMPT_TEMPLATE;
  return out;
}

function normalizeTranscriptConfig(raw = {}) {
  const cfg = normalizeWorkflowConfig({ transcript: raw }).transcript;
  const src = raw && typeof raw === 'object' ? raw : {};

  const windowSecondsRaw = Number(src.windowSeconds ?? src.chunkWindowSeconds ?? STT_WINDOW_SECONDS);
  const windowSeconds = Math.max(6, Number.isFinite(windowSecondsRaw) ? windowSecondsRaw : STT_WINDOW_SECONDS);

  const overlapSecondsRaw = Number(src.overlapSeconds ?? src.chunkOverlapSeconds ?? STT_OVERLAP_SECONDS);
  const overlapSeconds = Math.max(0, Math.min(windowSeconds - 1, Number.isFinite(overlapSecondsRaw) ? overlapSecondsRaw : STT_OVERLAP_SECONDS));

  const audioChannelRaw = String(src.audioChannel ?? STT_AUDIO_CHANNEL).trim().toLowerCase();
  const audioChannel = (audioChannelRaw === 'right' || audioChannelRaw === 'r')
    ? 'right'
    : ((audioChannelRaw === 'mix' || audioChannelRaw === 'both') ? 'mix' : 'left');

  const mergeModeRaw = String(src.mergeMode ?? '').trim().toLowerCase();
  const disableMerge = src.disableMerge === true || mergeModeRaw === 'off' || mergeModeRaw === 'none';
  const noTimestamps = src.noTimestamps === true;

  return {
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    language: cfg.language,
    prompt: cfg.prompt,
    responseFormat: cfg.responseFormat || 'verbose_json',
    windowSeconds,
    overlapSeconds,
    audioChannel,
    disableMerge,
    noTimestamps,
  };
}

function redactSecret(v = '') {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-2)}`;
}

function publicWorkflowConfig(cfg, includeSecrets = false) {
  const safe = normalizeWorkflowConfig(cfg || {});
  if (!includeSecrets) {
    safe.transcript.apiKey = safe.transcript.apiKey ? redactSecret(safe.transcript.apiKey) : '';
  }
  return safe;
}

function transcriptProviderChoices() {
  return [
    {
      id: 'local',
      label: 'On-device transcription server',
      apiUrl: LOCAL_STT_URL,
      model: LOCAL_STT_MODEL,
      requiresApiKey: false,
      hint: 'Fast local transcription on this device. API key usually not required.',
    },
    {
      id: 'openai',
      label: 'OpenAI API',
      apiUrl: 'https://api.openai.com/v1/audio/transcriptions',
      model: CLOUD_STT_MODEL || 'whisper-1',
      requiresApiKey: true,
      hint: 'Hosted transcription via OpenAI. Requires your API key.',
    },
    {
      id: 'custom',
      label: 'Custom endpoint',
      apiUrl: '',
      model: '',
      requiresApiKey: false,
      hint: 'Use any compatible endpoint and key pattern.',
    },
  ];
}

function detectTranscriptProviderInfo(apiUrl = '') {
  const url = String(apiUrl || '').trim().toLowerCase();
  const choices = transcriptProviderChoices();
  const local = choices.find((c) => c.id === 'local');
  const openai = choices.find((c) => c.id === 'openai');

  if (url && url.includes('api.openai.com/v1/audio/transcriptions')) {
    return { id: openai?.id || 'openai', label: openai?.label || 'OpenAI API' };
  }

  const localUrl = String(local?.apiUrl || '').trim().toLowerCase();
  if (url && localUrl && url === localUrl) {
    return { id: local?.id || 'local', label: local?.label || 'On-device transcription server' };
  }

  return { id: 'custom', label: 'Custom endpoint' };
}

function buildTranscriptSourceInfo(cfg = {}) {
  const safe = normalizeTranscriptConfig(cfg || {});
  const provider = detectTranscriptProviderInfo(safe.apiUrl);
  const windowSeconds = Math.max(6, Number(safe.windowSeconds || STT_WINDOW_SECONDS));
  const overlapSeconds = Math.max(0, Math.min(windowSeconds - 1, Number(safe.overlapSeconds ?? STT_OVERLAP_SECONDS)));
  const audioChannel = String(safe.audioChannel || STT_AUDIO_CHANNEL).trim().toLowerCase();
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    apiUrl: String(safe.apiUrl || '').trim(),
    model: String(safe.model || '').trim(),
    language: String(safe.language || '').trim() || 'en',
    responseFormat: String(safe.responseFormat || 'verbose_json').trim() || 'verbose_json',
    audioChannel,
    windowSeconds,
    overlapSeconds,
    stepSeconds: Math.max(1, windowSeconds - overlapSeconds),
  };
}

function sleepMs(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, code, obj) {
  return send(res, code, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });
}

async function streamFileWithRange(req, res, filePath, contentType = 'application/octet-stream') {
  const st = await fs.stat(filePath);
  if (!st.isFile()) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const total = Number(st.size || 0);
  const rangeHeader = String(req.headers.range || '').trim();

  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
    });
    fsSync.createReadStream(filePath).pipe(res);
    return;
  }

  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) {
    return send(res, 416, 'Range Not Satisfiable', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Range': `bytes */${total}`,
      'Accept-Ranges': 'bytes',
    });
  }

  let start = m[1] ? Number(m[1]) : Number.NaN;
  let end = m[2] ? Number(m[2]) : Number.NaN;

  if (!Number.isFinite(start) && Number.isFinite(end)) {
    const suffixLen = Math.max(1, end);
    start = Math.max(0, total - suffixLen);
    end = total - 1;
  } else {
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = total - 1;
  }

  start = Math.max(0, Math.floor(start));
  end = Math.min(total - 1, Math.floor(end));

  if (start > end || start >= total) {
    return send(res, 416, 'Range Not Satisfiable', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Range': `bytes */${total}`,
      'Accept-Ranges': 'bytes',
    });
  }

  const chunkSize = (end - start) + 1;
  res.writeHead(206, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': chunkSize,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
  });

  fsSync.createReadStream(filePath, { start, end }).pipe(res);
}

function safeParseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function normalizeAbs(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  return path.resolve(s);
}

function slugify(v) {
  return String(v || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function imageMimeFromName(name = '') {
  const low = name.toLowerCase();
  if (low.endsWith('.png')) return 'image/png';
  if (low.endsWith('.jpg') || low.endsWith('.jpeg')) return 'image/jpeg';
  if (low.endsWith('.webp')) return 'image/webp';
  if (low.endsWith('.avif')) return 'image/avif';
  return 'application/octet-stream';
}

function videoMimeFromName(name = '') {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME[ext] || 'video/mp4';
}

function inAllowedDir(fullPath, root) {
  const normRoot = path.resolve(root);
  const normPath = path.resolve(fullPath);
  return normPath === normRoot || normPath.startsWith(`${normRoot}${path.sep}`);
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return safeParseJson(raw, fallback);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

async function writeUserWorkflowAtomic(filePath, obj) {
  await writeJsonAtomic(filePath, obj);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function userWorkflowPathFor(storageRoot) {
  const root = normalizeAbs(storageRoot || defaultStorageRoot()) || defaultStorageRoot();
  return path.join(root, 'projects', LOCAL_WORKFLOW_FILENAME);
}

function transcriptHistoryPathFor(storageRoot) {
  const root = normalizeAbs(storageRoot || defaultStorageRoot()) || defaultStorageRoot();
  return path.join(root, 'projects', TRANSCRIPT_HISTORY_FILENAME);
}

function normalizeTranscriptHistory(raw = []) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of arr) {
    const find = String(row?.find || '').trim();
    const replace = String(row?.replace || '').trim();
    if (!find || !replace) continue;
    const key = `${find.toLowerCase()}\u0000${replace.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(row?.id || `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      find,
      replace,
      useCount: Math.max(0, Number(row?.useCount || 0)),
      updatedAt: String(row?.updatedAt || new Date().toISOString()),
    });
    if (out.length >= 120) break;
  }
  return out;
}

async function getTranscriptHistory(storageRoot) {
  const filePath = transcriptHistoryPathFor(storageRoot);
  const raw = await readJsonIfExists(filePath, { history: [] });
  return normalizeTranscriptHistory(raw?.history || []);
}

async function saveTranscriptHistory(storageRoot, history = []) {
  const filePath = transcriptHistoryPathFor(storageRoot);
  const normalized = normalizeTranscriptHistory(history || []);
  await writeUserWorkflowAtomic(filePath, { history: normalized });
  return normalized;
}

function serverConfigForDisk(cfg = {}) {
  const storageRoot = normalizeAbs(cfg.storageRoot || defaultStorageRoot()) || defaultStorageRoot();
  const customRoots = Array.isArray(cfg.customRoots) ? cfg.customRoots.map(normalizeAbs).filter(Boolean) : [];
  return {
    storageRoot,
    customRoots,
    workflow: defaultWorkflowConfig(),
  };
}

function defaultStorageRoot() {
  return normalizeAbs(process.env.PODPICS_DATA_HOME || DEVICE_DEFAULT_ROOT) || DEVICE_DEFAULT_ROOT;
}

function pathExistsSyncMaybe(p) {
  try {
    return fsSync.existsSync(p);
  } catch {
    return false;
  }
}

function isLegacyWorkspaceStorageRoot(root = '') {
  const normalized = normalizeAbs(root);
  if (!normalized) return false;
  const legacy = normalizeAbs(TEAM_DEFAULT_ROOT);
  if (!legacy) return false;
  return normalized === legacy || normalized.startsWith(`${legacy}${path.sep}`);
}

async function migrateStorageRootIfNeeded(fromRootRaw = '', toRootRaw = '') {
  const fromRoot = normalizeAbs(fromRootRaw);
  const toRoot = normalizeAbs(toRootRaw);
  if (!fromRoot || !toRoot || fromRoot === toRoot) return { migrated: false };
  if (!pathExistsSyncMaybe(fromRoot)) return { migrated: false };

  await fs.mkdir(toRoot, { recursive: true });
  await fs.cp(fromRoot, toRoot, { recursive: true, force: false, errorOnExist: false });
  return { migrated: true, fromRoot, toRoot };
}

async function loadServerConfig() {
  if (serverConfigCache) return serverConfigCache;
  const cfg = await readJsonIfExists(SERVER_CONFIG_PATH, {
    storageRoot: defaultStorageRoot(),
    customRoots: [],
    workflow: defaultWorkflowConfig(),
  });
  let shouldPersist = false;
  const candidateRoot = String(cfg.storageRoot || '').trim();
  if (!candidateRoot || candidateRoot === LEGACY_DROPBOX_ROOT || candidateRoot === LEGACY_LOCAL_ROOT) {
    cfg.storageRoot = defaultStorageRoot();
    shouldPersist = true;
  }
  const normalizedStorage = normalizeAbs(cfg.storageRoot || defaultStorageRoot()) || defaultStorageRoot();
  if (normalizedStorage !== cfg.storageRoot) shouldPersist = true;
  cfg.storageRoot = normalizedStorage;
  cfg.customRoots = Array.isArray(cfg.customRoots) ? cfg.customRoots.map(normalizeAbs).filter(Boolean) : [];

  const legacyStorage = isLegacyWorkspaceStorageRoot(cfg.storageRoot)
    || cfg.storageRoot === LEGACY_DROPBOX_ROOT
    || cfg.storageRoot === LEGACY_LOCAL_ROOT;
  const stableRoot = defaultStorageRoot();
  if (legacyStorage && cfg.storageRoot !== stableRoot) {
    await migrateStorageRootIfNeeded(cfg.storageRoot, stableRoot).catch(() => {});
    cfg.storageRoot = stableRoot;
    cfg.customRoots = cfg.customRoots.filter((r) => normalizeAbs(r) !== normalizeAbs(TEAM_DEFAULT_ROOT));
    shouldPersist = true;
  }

  const normalizedWorkflow = normalizeWorkflowConfig(cfg.workflow || {}, defaultWorkflowConfig());
  if (JSON.stringify(normalizedWorkflow) !== JSON.stringify(cfg.workflow || {})) shouldPersist = true;
  cfg.workflow = normalizedWorkflow;

  const userWorkflowRaw = await readJsonIfExists(userWorkflowPathFor(cfg.storageRoot), null);
  if (userWorkflowRaw && typeof userWorkflowRaw === 'object') {
    cfg.workflow = normalizeWorkflowConfig({
      ...cfg.workflow,
      ...userWorkflowRaw,
    }, cfg.workflow);
  } else {
    await writeUserWorkflowAtomic(userWorkflowPathFor(cfg.storageRoot), cfg.workflow).catch(() => {});
  }

  if (looksLikeMaskedApiKey(cfg.workflow?.transcript?.apiKey) || hasNonLatin1Chars(cfg.workflow?.transcript?.apiKey || '')) {
    cfg.workflow.transcript.apiKey = '';
    shouldPersist = true;
  }

  if (shouldPersist) await writeJsonAtomic(SERVER_CONFIG_PATH, serverConfigForDisk(cfg));
  if (shouldPersist) await writeUserWorkflowAtomic(userWorkflowPathFor(cfg.storageRoot), cfg.workflow).catch(() => {});
  serverConfigCache = cfg;
  return cfg;
}

async function saveServerConfig(cfg) {
  serverConfigCache = cfg;
  await writeJsonAtomic(SERVER_CONFIG_PATH, serverConfigForDisk(cfg));
  await writeUserWorkflowAtomic(userWorkflowPathFor(cfg.storageRoot), normalizeWorkflowConfig(cfg.workflow || {}, defaultWorkflowConfig()));
}

function derivePaths(storageRoot) {
  const root = normalizeAbs(storageRoot);
  return {
    storageRoot: root,
    timelinesRoot: path.join(root, 'Timelines'),
    ingestRoot: path.join(root, 'inbox'),
    projectsRoot: path.join(root, 'projects'),
    timelineOut: path.join(root, 'outputs', 'timelines-tests'),
    imageLibraryRoot: path.join(root, 'assets'),
    transcriptCandidates: [
      path.join(root, 'inbox', 'Episode 4.md'),
      path.join(root, 'inbox', 'transcript.md'),
      path.join(root, 'inbox', 'episode.md'),
    ],
    rawVideoDefault: path.join(root, 'inbox', 'Episode 4 Raw Video.mp4'),
    projectIndexPath: path.join(root, 'projects', 'projects-index.json'),
    promptsPath: path.join(root, 'projects', 'prompt-presets.json'),
  };
}

function rootsFromConfig(cfg) {
  const roots = uniq([cfg.storageRoot]).map(normalizeAbs);
  return roots.filter(Boolean);
}

async function ensureRuntimeFor(root) {
  const p = derivePaths(root);
  await fs.mkdir(p.timelinesRoot, { recursive: true });
  await fs.mkdir(p.ingestRoot, { recursive: true });
  await fs.mkdir(p.projectsRoot, { recursive: true });
  await fs.mkdir(p.timelineOut, { recursive: true });
  await fs.mkdir(p.imageLibraryRoot, { recursive: true });

  const legacyTemplateOtio = path.join(LEGACY_DROPBOX_ROOT, 'Timelines', 'Episode 4.otio');
  const legacyTemplateFcpxml = path.join(LEGACY_DROPBOX_ROOT, 'Timelines', 'Episode 4.fcpxml');
  const targetTemplateOtio = path.join(p.timelinesRoot, 'Episode 4.otio');
  const targetTemplateFcpxml = path.join(p.timelinesRoot, 'Episode 4.fcpxml');
  const targetTranscript = path.join(p.ingestRoot, 'Episode 4.md');
  const legacyTranscript = path.join(LEGACY_DROPBOX_ROOT, 'Timelines', 'Episode 4.md');

  if (!fsSync.existsSync(targetTemplateOtio) && fsSync.existsSync(legacyTemplateOtio)) {
    await fs.copyFile(legacyTemplateOtio, targetTemplateOtio).catch(() => {});
  }
  if (!fsSync.existsSync(targetTemplateFcpxml) && fsSync.existsSync(legacyTemplateFcpxml)) {
    await fs.copyFile(legacyTemplateFcpxml, targetTemplateFcpxml).catch(() => {});
  }
  if (!fsSync.existsSync(targetTranscript) && fsSync.existsSync(legacyTranscript)) {
    await fs.copyFile(legacyTranscript, targetTranscript).catch(() => {});
  }

  if (!fsSync.existsSync(p.projectIndexPath)) {
    await writeJsonAtomic(p.projectIndexPath, { projects: [] });
  }
  if (!fsSync.existsSync(p.promptsPath)) {
    await writeJsonAtomic(p.promptsPath, DEFAULT_PROMPTS);
  }
  return p;
}

async function currentRuntime() {
  const cfg = await loadServerConfig();
  const p = await ensureRuntimeFor(cfg.storageRoot);
  return { cfg, p };
}

async function setStorageRoot(newRootRaw) {
  const cfg = await loadServerConfig();
  const newRoot = normalizeAbs(newRootRaw);
  if (!newRoot) throw new Error('Invalid storage root');
  await fs.mkdir(newRoot, { recursive: true });
  cfg.storageRoot = newRoot;
  cfg.customRoots = uniq([...(cfg.customRoots || []), newRoot]).filter((r) => normalizeAbs(r) !== normalizeAbs(TEAM_DEFAULT_ROOT));
  await saveServerConfig(cfg);
  await ensureRuntimeFor(newRoot);
  return cfg;
}

async function setWorkflowConfig(nextWorkflow) {
  const cfg = await loadServerConfig();
  const existing = normalizeWorkflowConfig(cfg.workflow || {}, defaultWorkflowConfig());

  const merged = normalizeWorkflowConfig({
    ...existing,
    ...(nextWorkflow && typeof nextWorkflow === 'object' ? nextWorkflow : {}),
  }, existing);

  cfg.workflow = merged;
  await saveServerConfig(cfg);
  return cfg.workflow;
}

async function getPromptPresets(paths) {
  const presets = await readJsonIfExists(paths.promptsPath, DEFAULT_PROMPTS);
  return { ...DEFAULT_PROMPTS, ...(presets || {}) };
}

async function setPromptPresets(paths, presets) {
  const merged = { ...DEFAULT_PROMPTS, ...(presets || {}) };
  await writeJsonAtomic(paths.promptsPath, merged);
  return merged;
}

async function chooseTranscriptPath(paths) {
  for (const p of paths.transcriptCandidates) {
    if (fsSync.existsSync(p)) return p;
  }

  const mdFiles = [];
  async function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p, depth + 1);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const st = await fs.stat(p);
        mdFiles.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(paths.ingestRoot, 0);
  mdFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (mdFiles.length) return mdFiles[0].path;
  return null;
}

function parseTranscriptLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    if (!m) continue;
    out.push({ idx: out.length, tc: m[1], text: m[2] || '' });
  }
  if (!out.length) out.push({ idx: 0, tc: '00:00:00', text: 'Transcript placeholder line.' });
  return out;
}

function secondsToTc(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function tcToSeconds(tc) {
  const m = String(tc || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  const s = Number(m[3]);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || !Number.isFinite(s)) return Number.NaN;
  return (h * 3600) + (mm * 60) + s;
}

function estimateTranscriptDurationSeconds(lines = []) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length) return 0;
  const first = tcToSeconds(arr[0]?.tc || '');
  const last = tcToSeconds(arr[arr.length - 1]?.tc || '');
  if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
    return Math.max(1, (last - first) + 4);
  }
  return Math.max(1, arr.length * 4);
}

function spacingMinutesToLineGap(lines = [], durationSeconds = 0, spacingMinutes = 1) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length) return 1;
  const dur = Math.max(1, Number(durationSeconds) || estimateTranscriptDurationSeconds(arr));
  const secPerLine = Math.max(1, dur / Math.max(1, arr.length));
  const spacingSeconds = Math.max(1, Number(spacingMinutes || 1) * 60);
  return Math.max(1, Math.round(spacingSeconds / secPerLine));
}

function prefersJsonResponseForModel(model = '') {
  const m = String(model || '').trim().toLowerCase();
  return m.includes('gpt-4o-transcribe') || m.includes('gpt-4o-mini-transcribe');
}

function buildResponseFormatAttemptOrder(apiUrl = '', model = '', requested = 'verbose_json') {
  const req = String(requested || 'verbose_json').trim() || 'verbose_json';
  const list = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!list.includes(s)) list.push(s);
  };

  const isOpenAI = String(apiUrl || '').toLowerCase().includes('api.openai.com');
  if (isOpenAI && prefersJsonResponseForModel(model)) {
    push(req === 'verbose_json' ? 'json' : req);
    push('json');
    push('text');
    return list;
  }

  push(req);
  if (req !== 'json') push('json');
  return list;
}

function isResponseFormatCompatibilityError(status = 0, bodyText = '') {
  if (Number(status) !== 400) return false;
  const txt = String(bodyText || '').toLowerCase();
  return txt.includes('response_format') && (txt.includes('not compatible') || txt.includes('unsupported') || txt.includes('unsupported_value'));
}

function hasNonLatin1Chars(v = '') {
  const s = String(v || '');
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 255) return true;
  }
  return false;
}

function looksLikeMaskedApiKey(v = '') {
  const s = String(v || '').trim();
  if (!s) return false;
  return /[•*…]/.test(s);
}

function sttPanFilter(channel = STT_AUDIO_CHANNEL) {
  const c = String(channel || STT_AUDIO_CHANNEL).trim().toLowerCase();
  if (c === 'right' || c === 'r') return 'pan=mono|c0=FR';
  if (c === 'mix' || c === 'both') return 'pan=mono|c0=0.5*FL+0.5*FR';
  return 'pan=mono|c0=FL';
}

function splitTranscriptTextIntoParts(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];

  let parts = raw
    .split(/\n+|(?<=[.!?])\s+/g)
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  if (parts.length <= 1 && raw.includes(',')) {
    parts = raw
      .split(/,\s+/g)
      .map((s) => String(s || '').trim())
      .filter(Boolean);
  }

  return parts.length ? parts : [raw];
}

function normalizedWordCount(text = '', normalizeLineFn = (s) => s) {
  const n = String(normalizeLineFn(text) || '').trim();
  if (!n) return 0;
  return n.split(/\s+/g).filter(Boolean).length;
}

function shouldSkipNearDuplicateLine(lines = [], normalizeLineFn = (s) => s, text = '', absStart = 0, overlapSeconds = STT_OVERLAP_SECONDS) {
  const prev = lines[lines.length - 1];
  if (!prev) return false;

  const curNorm = normalizeLineFn(text);
  const prevNorm = normalizeLineFn(prev.text || '');
  if (!curNorm || curNorm !== prevNorm) return false;

  const prevSec = tcToSeconds(prev.tc || '');
  if (!Number.isFinite(prevSec)) return true;
  const overlap = Number(overlapSeconds ?? STT_OVERLAP_SECONDS);
  return Math.abs(Number(absStart || 0) - prevSec) <= Math.max(2, (Number.isFinite(overlap) ? overlap : STT_OVERLAP_SECONDS) + 1);
}

function tokenSet(text = '', normalizeLineFn = (s) => s) {
  const n = String(normalizeLineFn(text) || '').trim();
  if (!n) return new Set();
  return new Set(n.split(/\s+/g).filter(Boolean));
}

function tokenJaccard(textA = '', textB = '', normalizeLineFn = (s) => s) {
  const a = tokenSet(textA, normalizeLineFn);
  const b = tokenSet(textB, normalizeLineFn);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const uni = a.size + b.size - inter;
  return uni > 0 ? (inter / uni) : 0;
}

function mergeOverlapLinesPost(lines = [], normalizeLineFn = (s) => s, overlapSeconds = STT_OVERLAP_SECONDS) {
  const arr = (Array.isArray(lines) ? lines : [])
    .map((l, originalIdx) => ({
      originalIdx,
      tc: String(l?.tc || '00:00:00'),
      text: String(l?.text || '').trim(),
    }))
    .filter((l) => l.text)
    .map((l) => ({
      ...l,
      sec: tcToSeconds(l.tc),
      norm: normalizeLineFn(l.text),
      wc: normalizedWordCount(l.text, normalizeLineFn),
    }))
    .filter((l) => l.norm)
    .sort((a, b) => {
      const as = Number.isFinite(a.sec) ? a.sec : Number.MAX_SAFE_INTEGER;
      const bs = Number.isFinite(b.sec) ? b.sec : Number.MAX_SAFE_INTEGER;
      if (as !== bs) return as - bs;
      return a.originalIdx - b.originalIdx;
    });

  const merged = [];
  let dropped = 0;
  const nearWindow = Math.max(2, Number(overlapSeconds || 0) + 2);

  const preferCandidate = (prev, cur) => {
    if (cur.wc !== prev.wc) return cur.wc > prev.wc;
    if (cur.text.length !== prev.text.length) return cur.text.length > prev.text.length;
    return (Number(cur.sec) || 0) < (Number(prev.sec) || 0);
  };

  for (const cur of arr) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push(cur);
      continue;
    }

    const dt = Math.abs((Number(cur.sec) || 0) - (Number(prev.sec) || 0));
    const exact = cur.norm === prev.norm;
    const curHasPrev = cur.norm.includes(prev.norm);
    const prevHasCur = prev.norm.includes(cur.norm);
    const j = tokenJaccard(cur.text, prev.text, normalizeLineFn);

    const isTinyAck = Math.min(cur.wc, prev.wc) <= 2;
    const tightWindow = isTinyAck ? 1 : nearWindow;
    const nearEnough = dt <= tightWindow;

    const sameThought = exact
      || ((curHasPrev || prevHasCur) && j >= 0.72)
      || (j >= 0.9 && dt <= Math.max(2, Number(overlapSeconds || 0) + 1));

    if (nearEnough && sameThought) {
      if (preferCandidate(prev, cur)) {
        merged[merged.length - 1] = cur;
      }
      dropped += 1;
      continue;
    }

    merged.push(cur);
  }

  return {
    lines: merged.map((l, idx) => ({ idx, tc: l.tc, text: l.text })),
    dropped,
  };
}

function sectionBoundsFromWorkflow(lines = [], recommendationsCfg = {}) {
  const rec = recommendationsCfg && typeof recommendationsCfg === 'object' ? recommendationsCfg : {};
  const legacyPerMinute = Number(rec.sectionsPerMinute || 0);
  const legacyEveryRaw = Number(rec.sectionEveryMinutes ?? (legacyPerMinute > 0 ? (1 / legacyPerMinute) : 0));
  const maxGapRaw = Number(rec.sectionGapMaxMinutes ?? (legacyEveryRaw > 0 ? legacyEveryRaw : DEFAULT_SECTION_GAP_MAX_MINUTES));
  const maxGapMinutes = Math.max(0.2, Math.min(30, Number.isFinite(maxGapRaw) && maxGapRaw > 0 ? maxGapRaw : DEFAULT_SECTION_GAP_MAX_MINUTES));

  const minGapRaw = Number(rec.sectionGapMinMinutes ?? DEFAULT_SECTION_GAP_MIN_MINUTES);
  const minGapMinutes = Math.max(0.1, Math.min(maxGapMinutes, Number.isFinite(minGapRaw) && minGapRaw > 0 ? minGapRaw : DEFAULT_SECTION_GAP_MIN_MINUTES));

  const durationSeconds = estimateTranscriptDurationSeconds(lines);
  const durationMinutes = durationSeconds > 0 ? (durationSeconds / 60) : 0;

  const hasLines = Array.isArray(lines) && lines.length > 0;
  if (!hasLines) {
    return {
      minCount: 0,
      maxCount: 0,
      targetCount: 0,
      minGapMinutes,
      maxGapMinutes,
      durationMinutes,
      durationSeconds,
    };
  }

  const minByCoverage = durationMinutes > 0
    ? Math.max(1, Math.ceil(durationMinutes / maxGapMinutes))
    : 1;

  const maxBySpacing = durationMinutes > 0
    ? Math.max(1, Math.floor(durationMinutes / minGapMinutes) + 1)
    : 1;

  const maxSectionsRaw = Number(rec.maxSections ?? 64);
  const configuredMaxSections = Math.max(1, Math.min(96, Number.isFinite(maxSectionsRaw) ? Math.round(maxSectionsRaw) : 64));
  const hardCap = Math.max(1, Math.min(configuredMaxSections, lines.length));
  const maxCount = Math.max(1, Math.min(hardCap, maxBySpacing));
  const minCount = Math.max(1, Math.min(maxCount, minByCoverage));
  const targetCount = Math.max(minCount, Math.min(maxCount, minByCoverage));

  return {
    minCount,
    maxCount,
    targetCount,
    minGapMinutes,
    maxGapMinutes,
    durationMinutes,
    durationSeconds,
  };
}

function sectionDurationRulesFromWorkflow(recommendationsCfg = {}) {
  const rec = recommendationsCfg && typeof recommendationsCfg === 'object' ? recommendationsCfg : {};
  const minRaw = Number(rec.sectionDurationMinSeconds ?? DEFAULT_SECTION_DURATION_MIN_SECONDS);
  const maxRaw = Number(rec.sectionDurationMaxSeconds ?? DEFAULT_SECTION_DURATION_MAX_SECONDS);

  const minSeconds = Math.max(1, Math.min(30, Number.isFinite(minRaw) ? minRaw : DEFAULT_SECTION_DURATION_MIN_SECONDS));
  const maxSeconds = Math.max(minSeconds + 0.5, Math.min(60, Number.isFinite(maxRaw) ? maxRaw : DEFAULT_SECTION_DURATION_MAX_SECONDS));
  return { minSeconds, maxSeconds };
}

function estimateSectionDurationSeconds(snippetLines = [], recommendationsCfg = {}) {
  const rules = sectionDurationRulesFromWorkflow(recommendationsCfg);
  const lines = Array.isArray(snippetLines) ? snippetLines : [];
  const text = lines.map((l) => String(l?.text || '')).join(' ').trim();
  if (!text) return rules.minSeconds;
  const words = text.split(/\s+/).filter(Boolean).length;
  const estimatedFromWords = (words / 155) * 60 + 0.6;
  const estimate = Number.isFinite(estimatedFromWords) && estimatedFromWords > 0 ? estimatedFromWords : rules.minSeconds;
  return Math.max(rules.minSeconds, Math.min(rules.maxSeconds, estimate));
}

async function probeDurationSeconds(videoPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    const n = Number(String(stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function transcribeAudioChunkOpenAIStyle(audioPath, transcriptConfig = {}, rollingPrompt = '', opts = {}) {
  const cfg = normalizeTranscriptConfig(transcriptConfig || {});
  const apiUrl = cfg.apiUrl || DEFAULT_STT_URL;
  const model = cfg.model || DEFAULT_STT_MODEL;
  const language = cfg.language || LOCAL_STT_LANGUAGE;
  const defaultPrompt = prefersJsonResponseForModel(model)
    ? 'Transcribe the spoken words verbatim in English. Do not summarize or paraphrase.'
    : LOCAL_STT_PROMPT;
  const basePrompt = cfg.prompt || defaultPrompt;
  const apiKey = String(cfg.apiKey || '').trim();

  if (apiKey && (hasNonLatin1Chars(apiKey) || looksLikeMaskedApiKey(apiKey))) {
    throw new Error('Saved API key appears masked/invalid. Re-enter your full API key in Step 2 and try again.');
  }

  const responseFormats = buildResponseFormatAttemptOrder(apiUrl, model, cfg.responseFormat || 'verbose_json');
  const timeoutMs = Math.max(5_000, Number(opts.timeoutMs || STT_CHUNK_TIMEOUT_MS));

  const promptTail = STT_USE_ROLLING_PROMPT ? String(rollingPrompt || '').slice(-STT_PROMPT_TAIL_CHARS).trim() : '';
  const prompt = `${basePrompt}${promptTail ? ` ${promptTail}` : ''}`.trim();
  const bytes = await fs.readFile(audioPath);

  const headers = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let lastErr = null;
  for (let i = 0; i < responseFormats.length; i += 1) {
    const responseFormat = responseFormats[i];
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(audioPath));
    form.append('model', model);
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    if (responseFormat) form.append('response_format', responseFormat);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`Transcription timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    let r;
    try {
      r = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = String(err?.message || err || 'Transcription API request failed');
      throw new Error(`Transcription API request failed: ${msg}`);
    }
    clearTimeout(timeoutId);

    if (r.ok) {
      return r.json();
    }

    const txt = await r.text().catch(() => '');
    lastErr = new Error(`Transcription API failed (${r.status}): ${txt.slice(0, 280)}`);
    const canRetryFormat = i < (responseFormats.length - 1) && isResponseFormatCompatibilityError(r.status, txt);
    if (!canRetryFormat) throw lastErr;
  }

  throw (lastErr || new Error('Transcription API failed'));
}

async function transcribeChunkWithRetries(audioPath, transcriptConfig = {}, rollingPrompt = '', opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts || STT_CHUNK_MAX_ATTEMPTS));
  let attemptsUsed = 0;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const out = await transcribeAudioChunkOpenAIStyle(audioPath, transcriptConfig, rollingPrompt, {
        timeoutMs: opts.timeoutMs,
      });
      return { out, attemptsUsed };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await sleepMs(STT_CHUNK_RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  throw (lastErr || new Error('Chunk transcription failed'));
}

async function repairLargeTranscriptGaps(lines = [], videoPath = '', transcriptConfig = {}, opts = {}) {
  const audioChannel = String(transcriptConfig?.audioChannel || STT_AUDIO_CHANNEL).trim().toLowerCase();
  const normalizeLine = (text) => String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const maxRepairs = Math.max(0, Number(opts.maxRepairs ?? 6));
  const minGapSeconds = Math.max(12, Number(opts.minGapSeconds || 20));
  const maxGapSeconds = Math.max(minGapSeconds, Number(opts.maxGapSeconds || 90));
  const repairLines = [];
  const warnings = [];

  const sorted = (Array.isArray(lines) ? lines : [])
    .map((l) => ({ ...l, _sec: tcToSeconds(String(l?.tc || '')) }))
    .filter((l) => Number.isFinite(l._sec))
    .sort((a, b) => a._sec - b._sec);

  let repairsDone = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (repairsDone >= maxRepairs) break;

    const a = sorted[i];
    const b = sorted[i + 1];
    const gap = Number(b._sec || 0) - Number(a._sec || 0);
    if (!(gap >= minGapSeconds && gap <= maxGapSeconds)) continue;

    const segStart = Math.max(0, Math.floor(a._sec + 1));
    const segEnd = Math.max(segStart + 1, Math.floor(b._sec - 1));
    const segLen = Math.max(1, segEnd - segStart);
    if (segLen < 6) continue;

    const tmpAudio = path.join('/tmp', `podpics-gap-${Date.now()}-${randomUUID()}.wav`);
    try {
      await execFileAsync('ffmpeg', [
        '-v', 'error',
        '-y',
        '-ss', String(segStart),
        '-i', videoPath,
        '-t', String(segLen),
        '-vn',
        '-af', sttPanFilter(audioChannel),
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        tmpAudio,
      ], {
        timeout: 120000,
        maxBuffer: 4_000_000,
      });

      const { out } = await transcribeChunkWithRetries(tmpAudio, transcriptConfig, '', {
        maxAttempts: 2,
        timeoutMs: Math.max(20_000, Number(STT_CHUNK_TIMEOUT_MS || 120_000)),
      });

      const gapText = String(out?.text || '').trim();
      if (!gapText) continue;
      if (normalizedWordCount(gapText, normalizeLine) < 6) continue;

      const parts = splitTranscriptTextIntoParts(gapText);
      const totalChars = Math.max(1, parts.reduce((sum, p) => sum + String(p || '').length, 0));
      let consumed = 0;
      let inserted = 0;

      for (const part of parts) {
        const p = String(part || '').trim();
        if (!p) continue;
        const ratio = Math.max(0, Math.min(0.999, consumed / totalChars));
        const relStart = Math.round(ratio * segLen);
        const absStart = segStart + relStart;
        if (shouldSkipNearDuplicateLine(lines, normalizeLine, p, absStart, 0)) {
          consumed += p.length;
          continue;
        }
        repairLines.push({ tc: secondsToTc(absStart), text: p, idx: -1 });
        inserted += 1;
        consumed += p.length;
      }

      if (inserted > 0) {
        repairsDone += 1;
        warnings.push(`Gap repair: inserted ${inserted} line(s) for ${secondsToTc(segStart)} → ${secondsToTc(segEnd)}.`);
      }
    } catch (err) {
      warnings.push(`Gap repair skipped (${secondsToTc(segStart)} → ${secondsToTc(segEnd)}): ${String(err?.message || err)}`);
    } finally {
      await fs.rm(tmpAudio, { force: true }).catch(() => {});
    }
  }

  if (!repairLines.length) return { lines, warnings, repaired: 0 };

  const merged = [...lines, ...repairLines]
    .map((l) => ({
      tc: String(l?.tc || '00:00:00'),
      text: String(l?.text || '').trim(),
    }))
    .filter((l) => l.text)
    .sort((a, b) => tcToSeconds(a.tc) - tcToSeconds(b.tc));

  const out = [];
  for (const l of merged) {
    if (!out.length) {
      out.push(l);
      continue;
    }
    const prev = out[out.length - 1];
    if (normalizeLine(prev.text) === normalizeLine(l.text) && Math.abs(tcToSeconds(prev.tc) - tcToSeconds(l.tc)) <= 3) {
      continue;
    }
    out.push(l);
  }

  return {
    lines: out.map((l, idx) => ({ idx, tc: l.tc, text: l.text })),
    warnings,
    repaired: repairsDone,
  };
}

async function transcribeVideoToLines(videoPath, transcriptConfig = {}, onProgress = () => {}) {
  const duration = await probeDurationSeconds(videoPath);
  const windowSeconds = Math.max(6, Number(transcriptConfig?.windowSeconds || STT_WINDOW_SECONDS));
  const overlapSeconds = Math.max(0, Math.min(windowSeconds - 1, Number(transcriptConfig?.overlapSeconds ?? STT_OVERLAP_SECONDS)));
  const audioChannel = String(transcriptConfig?.audioChannel || STT_AUDIO_CHANNEL).trim().toLowerCase();
  const disableMerge = transcriptConfig?.disableMerge === true;
  const noTimestamps = transcriptConfig?.noTimestamps === true;
  // Important: never discard overlap-region text during chunk assembly.
  // Collect everything first, then collapse duplicates in one timestamp-sorted post-merge pass.
  const discardDuringAssembly = false;
  const stepSeconds = Math.max(1, windowSeconds - overlapSeconds);
  const totalDuration = duration > 0 ? duration : windowSeconds;
  const totalChunks = Math.max(1, Math.ceil(totalDuration / stepSeconds));
  const lines = [];
  const warnings = [];
  const chunkStats = [];
  let failedChunks = 0;
  let emptyChunks = 0;
  let retriesUsed = 0;
  let rollingPrompt = '';

  onProgress({
    completedChunks: 0,
    totalChunks,
    percent: 0,
    lineCount: 0,
    lines: [],
    failedChunks: 0,
    emptyChunks: 0,
    retriesUsed: 0,
    warningsCount: 0,
  });

  const normalizeLine = (text) => String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (let i = 0; i < totalChunks; i += 1) {
    const chunkStart = i * stepSeconds;
    if (duration > 0 && chunkStart >= duration) break;

    const chunkLen = duration > 0
      ? Math.max(1, Math.min(windowSeconds, Math.ceil(duration - chunkStart)))
      : windowSeconds;

    const tmpAudio = path.join('/tmp', `podpics-stt-${Date.now()}-${randomUUID()}.wav`);
    const stat = {
      chunkIndex: i,
      chunkNumber: i + 1,
      chunkStartSec: chunkStart,
      chunkDurationSec: chunkLen,
      attempts: 0,
      linesAdded: 0,
      status: 'running',
      error: null,
    };

    const beforeCount = lines.length;
    try {
      await execFileAsync('ffmpeg', [
        '-v', 'error',
        '-y',
        '-ss', String(chunkStart),
        '-i', videoPath,
        '-t', String(chunkLen),
        '-vn',
        '-af', sttPanFilter(audioChannel),
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        tmpAudio,
      ], {
        timeout: 180000,
        maxBuffer: 8_000_000,
      });

      const { out, attemptsUsed } = await transcribeChunkWithRetries(tmpAudio, transcriptConfig, rollingPrompt, {
        maxAttempts: STT_CHUNK_MAX_ATTEMPTS,
        timeoutMs: STT_CHUNK_TIMEOUT_MS,
      });

      stat.attempts = attemptsUsed;
      retriesUsed += Math.max(0, attemptsUsed - 1);

      const segs = Array.isArray(out?.segments) ? out.segments : [];
      const newTexts = [];
      const fullText = String(out?.text || '').trim();
      const useTextFirst = !!(fullText && prefersJsonResponseForModel(String(transcriptConfig?.model || '')));

      if (noTimestamps) {
        if (fullText) {
          lines.push({ idx: lines.length, tc: secondsToTc(chunkStart), text: fullText });
          newTexts.push(fullText);
        }
      } else if (useTextFirst) {
        const parts = splitTranscriptTextIntoParts(fullText);
        const totalChars = Math.max(1, parts.reduce((sum, p) => sum + String(p || '').length, 0));
        let consumed = 0;

        for (const part of parts) {
          const p = String(part || '').trim();
          if (!p) continue;
          const ratio = Math.max(0, Math.min(0.999, consumed / totalChars));
          const relStart = Math.round(ratio * Math.max(1, chunkLen));
          if (discardDuringAssembly && parts.length > 1 && i > 0 && relStart < overlapSeconds) {
            consumed += p.length;
            continue;
          }
          const absStart = chunkStart + relStart;

          if (discardDuringAssembly && shouldSkipNearDuplicateLine(lines, normalizeLine, p, absStart, overlapSeconds)) {
            consumed += p.length;
            continue;
          }

          lines.push({ idx: lines.length, tc: secondsToTc(absStart), text: p });
          newTexts.push(p);
          consumed += p.length;
        }
      } else if (segs.length) {
        for (const seg of segs) {
          const text = String(seg?.text || '').trim();
          if (!text) continue;

          const segStart = Number(seg?.start || 0);
          const segEnd = Number(seg?.end);
          if (discardDuringAssembly && i > 0 && Number.isFinite(segStart) && Number.isFinite(segEnd) && segEnd <= overlapSeconds) {
            continue;
          }

          const effectiveSegStart = (discardDuringAssembly && i > 0 && Number.isFinite(segStart) && segStart < overlapSeconds)
            ? overlapSeconds
            : (Number.isFinite(segStart) ? segStart : 0);
          const absStart = chunkStart + effectiveSegStart;
          const norm = normalizeLine(text);
          if (!norm) continue;

          if (discardDuringAssembly && shouldSkipNearDuplicateLine(lines, normalizeLine, text, absStart, overlapSeconds)) {
            continue;
          }

          lines.push({ idx: lines.length, tc: secondsToTc(absStart), text });
          newTexts.push(text);
        }

        const fallbackText = String(out?.text || '').trim();
        if (!newTexts.length) {
          if (fallbackText) {
            const fallbackStart = chunkStart + (discardDuringAssembly && i > 0 ? overlapSeconds : 0);
            if (!discardDuringAssembly || !shouldSkipNearDuplicateLine(lines, normalizeLine, fallbackText, fallbackStart, overlapSeconds)) {
              lines.push({ idx: lines.length, tc: secondsToTc(fallbackStart), text: fallbackText });
              newTexts.push(fallbackText);
            }
          }
        } else if (fallbackText) {
          const rawWordCount = normalizedWordCount(fallbackText, normalizeLine);
          const segWordCount = newTexts.reduce((sum, txt) => sum + normalizedWordCount(txt, normalizeLine), 0);
          const coverageRatio = rawWordCount > 0 ? (segWordCount / rawWordCount) : 1;

          if (rawWordCount >= 14 && coverageRatio < 0.55) {
            const parts = splitTranscriptTextIntoParts(fallbackText);
            const totalChars = Math.max(1, parts.reduce((sum, p) => sum + String(p || '').length, 0));
            let consumed = 0;
            let supplemented = 0;

            for (const part of parts) {
              const p = String(part || '').trim();
              if (!p) continue;
              const ratio = Math.max(0, Math.min(0.999, consumed / totalChars));
              const relStart = Math.round(ratio * Math.max(1, chunkLen));
              if (discardDuringAssembly && parts.length > 1 && i > 0 && relStart < overlapSeconds) {
                consumed += p.length;
                continue;
              }
              const absStart = chunkStart + relStart;
              if (discardDuringAssembly && shouldSkipNearDuplicateLine(lines, normalizeLine, p, absStart, overlapSeconds)) {
                consumed += p.length;
                continue;
              }
              lines.push({ idx: lines.length, tc: secondsToTc(absStart), text: p });
              supplemented += 1;
              consumed += p.length;
            }

            if (supplemented > 0) {
              warnings.push(`Chunk ${i + 1}/${totalChunks}: supplemented ${supplemented} text part(s) because segment coverage looked sparse (${Math.round(coverageRatio * 100)}%).`);
            }
          }
        }
      } else {
        const text = fullText;
        if (text) {
          const parts = splitTranscriptTextIntoParts(text);
          const totalChars = Math.max(1, parts.reduce((sum, p) => sum + String(p || '').length, 0));
          let consumed = 0;

          for (const part of parts) {
            const p = String(part || '').trim();
            if (!p) continue;
            const ratio = Math.max(0, Math.min(0.999, consumed / totalChars));
            const relStart = Math.round(ratio * Math.max(1, chunkLen));
            if (discardDuringAssembly && parts.length > 1 && i > 0 && relStart < overlapSeconds) {
              consumed += p.length;
              continue;
            }
            const absStart = chunkStart + relStart;

            if (discardDuringAssembly && shouldSkipNearDuplicateLine(lines, normalizeLine, p, absStart, overlapSeconds)) {
              consumed += p.length;
              continue;
            }

            lines.push({ idx: lines.length, tc: secondsToTc(absStart), text: p });
            newTexts.push(p);
            consumed += p.length;
          }

          if (!newTexts.length) {
            const fallbackStart = chunkStart + (discardDuringAssembly && i > 0 ? overlapSeconds : 0);
            if (!discardDuringAssembly || !shouldSkipNearDuplicateLine(lines, normalizeLine, text, fallbackStart, overlapSeconds)) {
              lines.push({ idx: lines.length, tc: secondsToTc(fallbackStart), text });
              newTexts.push(text);
            }
          }
        }
      }

      if (STT_USE_ROLLING_PROMPT && newTexts.length) {
        rollingPrompt = `${rollingPrompt} ${newTexts.join(' ')}`.trim();
        if (rollingPrompt.length > STT_PROMPT_TAIL_CHARS * 3) {
          rollingPrompt = rollingPrompt.slice(-STT_PROMPT_TAIL_CHARS * 3);
        }
      }

      stat.linesAdded = Math.max(0, lines.length - beforeCount);
      if (stat.linesAdded > 0) {
        stat.status = 'ok';
      } else {
        stat.status = 'empty';
        emptyChunks += 1;
        warnings.push(`Chunk ${i + 1}/${totalChunks} returned no usable lines.`);
      }
    } catch (err) {
      stat.status = 'failed';
      stat.error = String(err?.message || err);
      failedChunks += 1;
      warnings.push(`Chunk ${i + 1}/${totalChunks} failed: ${stat.error}`);
    } finally {
      if (!stat.attempts) stat.attempts = 1;
      chunkStats.push(stat);
      await fs.rm(tmpAudio, { force: true }).catch(() => {});
    }

    onProgress({
      completedChunks: i + 1,
      totalChunks,
      percent: Math.round(((i + 1) / totalChunks) * 100),
      lineCount: lines.length,
      lines: lines.slice(),
      failedChunks,
      emptyChunks,
      retriesUsed,
      warningsCount: warnings.length,
    });
  }

  if (!lines.length) {
    throw new Error(`Transcription produced no text. Failed chunks: ${failedChunks}/${totalChunks}.`);
  }

  let cleanLines = lines
    .map((l, idx) => ({ idx, tc: String(l.tc || '00:00:00'), text: String(l.text || '').trim() }))
    .filter((l) => l.text);

  try {
    const repaired = await repairLargeTranscriptGaps(cleanLines, videoPath, transcriptConfig, {
      minGapSeconds: 20,
      maxGapSeconds: 90,
      maxRepairs: 0,
    });
    if (Array.isArray(repaired?.lines) && repaired.lines.length) {
      cleanLines = repaired.lines.map((l, idx) => ({ idx, tc: String(l.tc || '00:00:00'), text: String(l.text || '').trim() })).filter((l) => l.text);
    }
    if (Array.isArray(repaired?.warnings) && repaired.warnings.length) {
      warnings.push(...repaired.warnings);
    }
  } catch (err) {
    warnings.push(`Gap repair pass failed: ${String(err?.message || err)}`);
  }

  if (!disableMerge && !noTimestamps) {
    const merged = mergeOverlapLinesPost(cleanLines, normalizeLine, overlapSeconds);
    if (Array.isArray(merged?.lines) && merged.lines.length) {
      if (Number(merged?.dropped || 0) > 0) {
        warnings.push(`Post-merge: collapsed ${Number(merged.dropped)} overlap duplicate line(s).`);
      }
      cleanLines = merged.lines;
    }
  }

  return {
    lines: cleanLines,
    warnings,
    stats: {
      totalChunks,
      failedChunks,
      emptyChunks,
      retriesUsed,
      durationSeconds: duration > 0 ? duration : totalDuration,
      stepSeconds,
      windowSeconds,
      overlapSeconds,
      mergeMode: disableMerge ? 'off' : (noTimestamps ? 'bypass' : 'smart'),
      assemblyDiscardMode: discardDuringAssembly ? 'overlap-region' : 'none',
      timestampsMode: noTimestamps ? 'chunk-text-only' : 'normal',
    },
    chunkStats,
  };
}

function pruneTranscriptJobs() {
  const arr = [...transcriptJobs.values()].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  for (const j of arr.slice(MAX_TRANSCRIPT_JOBS)) {
    transcriptJobs.delete(j.id);
  }
}

function getTranscriptJobPublic(job, includeLines = false) {
  const out = {
    ok: true,
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    videoPath: job.videoPath,
    transcriptConfig: job.transcriptConfig || null,
    source: job.source || null,
    progress: job.progress || { completedChunks: 0, totalChunks: 0, percent: 0 },
    lineCount: Number(job.lineCount || 0),
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
    stats: job.stats || null,
  };
  if (includeLines) out.lines = job.lines || [];
  if (includeLines) out.chunkStats = Array.isArray(job.chunkStats) ? job.chunkStats : [];
  return out;
}

async function startTranscriptJob(paths, videoPath, transcriptConfig = {}) {
  const effectiveTranscriptConfig = normalizeTranscriptConfig(transcriptConfig || {});
  const ext = path.extname(String(videoPath || '')).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) throw new Error('Selected file is not a supported video');
  if (!inAllowedDir(videoPath, paths.ingestRoot)) throw new Error('Video must be inside inbox folder');
  if (!fsSync.existsSync(videoPath)) throw new Error('Video file not found');

  const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const job = {
    id,
    status: 'queued',
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
    startedAt: null,
    finishedAt: null,
    videoPath,
    progress: { completedChunks: 0, totalChunks: 0, percent: 0 },
    lineCount: 0,
    lines: [],
    error: null,
    warnings: [],
    stats: null,
    chunkStats: [],
    source: buildTranscriptSourceInfo(effectiveTranscriptConfig),
    transcriptConfig: {
      ...effectiveTranscriptConfig,
      apiKey: effectiveTranscriptConfig.apiKey ? redactSecret(effectiveTranscriptConfig.apiKey) : '',
    },
  };
  transcriptJobs.set(id, job);
  pruneTranscriptJobs();

  (async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const result = await transcribeVideoToLines(videoPath, effectiveTranscriptConfig, (p) => {
        job.progress = p;
        if (Array.isArray(p?.lines)) {
          job.lines = p.lines;
          job.lineCount = p.lines.length;
        } else {
          job.lineCount = p.lineCount;
        }
      });
      const lines = Array.isArray(result?.lines) ? result.lines : [];
      job.lines = lines;
      job.lineCount = lines.length;
      job.warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      job.stats = result?.stats || null;
      job.chunkStats = Array.isArray(result?.chunkStats) ? result.chunkStats : [];
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'error';
      job.error = String(err?.message || err);
      job.finishedAt = new Date().toISOString();
    }
  })().catch(() => {});

  return job;
}

function findLineIndex(lines, keyword) {
  const k = String(keyword || '').toLowerCase();
  if (!k) return -1;
  return lines.findIndex((l) => String(l.text || '').toLowerCase().includes(k));
}

async function listCategoryImages(paths, category, limit = 250) {
  const dirName = CATEGORY_DIRS[category];
  const candidateDirs = [];
  if (dirName) candidateDirs.push(path.join(paths.imageLibraryRoot, dirName));
  candidateDirs.push(paths.imageLibraryRoot);
  candidateDirs.push(paths.ingestRoot);

  const out = [];
  const seen = new Set();

  async function walk(dir, depth = 0) {
    if (depth > 3 || out.length >= limit) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (out.length >= limit) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({
          name: ent.name,
          path: p,
          url: `${BASE}/api/image?path=${encodeURIComponent(p)}`,
        });
      }
    }
  }

  for (const d of candidateDirs) {
    await walk(d, 0);
    if (out.length >= limit) break;
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

function styleCategory(styleKey, presets) {
  return String(presets?.[styleKey]?.category || 'reference');
}

function styleDefaultCount(styleKey, presets) {
  return Math.max(1, Number(presets?.[styleKey]?.defaultCount || 2));
}

function stylePrompt(styleKey, presets) {
  return String(presets?.[styleKey]?.prompt || 'Generate images for this transcript segment.');
}

const FIGURE_REFERENCE_TERMS = [
  'plato', 'aristotle', 'socrates', 'nietzsche', 'kant', 'descartes', 'confucius', 'lao tzu', 'laozi', 'seneca', 'marcus aurelius',
  'epictetus', 'thomas aquinas', 'david hume', 'john locke', 'immanuel kant', 'karl marx', 'friedrich engels', 'hegel', 'spinoza',
  'benjamin franklin', 'charles darwin', 'darwin', 'newton', 'einstein', 'tesla', 'galileo', 'lincoln', 'churchill', 'napoleon',
  'will durant', 'voltaire', 'thomas jefferson', 'bertrand russell', 'hellenistic', 'hellinistic', 'cialdini', 'robert cialdini',
  'marcus', 'commodus', 'hl mencken', 'h.l. mencken', 'mencken', 'john of god', 'adam smith', 'john stuart mill',
];

const MEDIA_TITLE_TERMS = [
  'idiocracy', 'dumb and dumber', 'count of monte cristo', 'starship troopers', 'green zone', 'guide to the good life',
  '1984', 'brave new world', 'brawndo', 'movie poster', 'book cover', 'cover art', 'peoplekind',
];

const STRONG_EVIDENCE_TERMS = [
  'cdc', 'nih', 'fda', 'pubmed', 'doi', 'arxiv', 'myocarditis', 'measles', 'smallpox', 'polio',
  'meta-analysis', 'meta analysis', 'confidence interval', 'sample size', 'published in', 'cohort', 'relative risk',
  'mortality', 'incidence', 'studies show', 'data shows', 'research shows', 'trial shows', 'chart', 'graph',
  'natural immunity', 'immune system', 'vaccine efficacy', 'adverse event', 'transmission evidence',
  'stock performance', 'congress stock', 'congressional stock', 'insider trading', 'portfolio performance',
];

const WEAK_EVIDENCE_TERMS = [
  'risk', 'evidence', 'science', 'research', 'study', 'studies', 'data', 'statistics', 'findings',
];

const MEME_CUE_TERMS = [
  'meme', 'joke', 'funny', 'laugh', 'sarcasm', 'roast', 'wild take', 'chaotic', 'drama', 'internet', 'viral', 'hot take',
];

function rxEscape(s = '') {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(text = '', phrase = '') {
  const p = String(phrase || '').trim();
  if (!p) return false;
  return new RegExp(`\\b${rxEscape(p).replace(/\\\s+/g, '\\s+')}\\b`, 'i').test(String(text || ''));
}

function hasAnyPhrase(text = '', list = []) {
  for (const p of list) {
    if (hasPhrase(text, p)) return true;
  }
  return false;
}

function hasNamedFigureReference(text = '') {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  if (hasAnyPhrase(low, FIGURE_REFERENCE_TERMS)) return true;
  return /\b(philosopher|historian|psychologist|economist|scientist|physicist|founding father|stoic|thinker)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/.test(raw);
}

function hasSpecificMediaReference(text = '') {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  const hasMediaWord = /\b(book|novel|movie|film|documentary|series|show|episode|screenplay|cover)\b/.test(low);
  const hasTitleCue = /\b(called|titled|from|adapted|the movie|the film|the book|cover art|movie poster|book cover)\b/.test(low);
  const hasQuotedTitle = /["“”][^"“”]{2,90}["“”]/.test(raw);
  const hasKnownTitleTerm = hasAnyPhrase(low, MEDIA_TITLE_TERMS);
  return hasKnownTitleTerm || (hasMediaWord && (hasTitleCue || hasQuotedTitle || /\bmovie cover\b|\bbook cover\b/.test(low)));
}

function hasSpecificStudyReference(text = '') {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  const hasStudyWord = /\b(study|studies|paper|papers|research|meta-analysis|meta analysis|trial|cohort|dataset|survey|journal|published|doi|arxiv|pubmed|statistics|findings)\b/.test(low);
  const hasStrongEvidenceTerm = hasAnyPhrase(low, STRONG_EVIDENCE_TERMS);
  const hasWeakEvidenceTerm = hasAnyPhrase(low, WEAK_EVIDENCE_TERMS);
  const hasHealthClaimCue = /\b(vaccine|vaccines|booster|boosters|natural immunity|measles|smallpox|polio|myocarditis|immune system|infection|disease|transmission|mortality|disability|face masks?|masks?)\b/.test(low);
  const hasFinanceMetricCue = /\b(stock|stocks|market|portfolio|trading|trades|returns?|performance|congressional trading|insider trading)\b/.test(low)
    && /\b(congress|pelosi|politician|politicians|officials?|bought|sold|buy|sell|outperform|underperform|returns?|performance|portfolio|market)\b/.test(low);
  const hasMeasurablePoliticsCue = /\b(bot accounts?|funding|poll|polling|executive orders?|voter turnout|approval rating|market performance)\b/.test(low);
  if (!hasStudyWord && !hasStrongEvidenceTerm && !hasWeakEvidenceTerm && !hasHealthClaimCue && !hasFinanceMetricCue && !hasMeasurablePoliticsCue) return false;
  const hasCitationCue = /\b(according to|published in|study from|researchers at|journal of|sample size|confidence interval|p\s*[<=>]|n\s*=)\b/.test(low);
  const hasNumberCue = /\b\d{4}\b/.test(raw) || /\b\d+(?:\.\d+)?%\b/.test(raw);
  const hasClaimCue = /\b(studies?\s+show|research\s+shows?|data\s+shows?|evidence\s+shows?|trial\s+shows?)\b/.test(low);
  const hasComparisonCue = /\b(risks?\s+(?:versus|vs\.?)\s+rewards?|case-by-case|gold standard|more effective|less effective|worked for|worse at|better at|outperform|underperform)\b/.test(low);
  const genericCommentaryOnly = /\b(authority|authorities|free thinker|claims?|manipulat|certainty|outsource|pedestal|tribe|belief|emotion|narrative)\b/.test(low)
    && !hasStudyWord
    && !hasStrongEvidenceTerm
    && !hasCitationCue
    && !hasNumberCue
    && !hasHealthClaimCue
    && !hasFinanceMetricCue
    && !hasMeasurablePoliticsCue;
  if (genericCommentaryOnly) return false;
  return hasStrongEvidenceTerm
    || hasCitationCue
    || (hasStudyWord && (hasClaimCue || hasNumberCue || hasComparisonCue || hasHealthClaimCue))
    || (hasHealthClaimCue && (hasNumberCue || hasComparisonCue || hasClaimCue || hasWeakEvidenceTerm))
    || (hasFinanceMetricCue && (hasNumberCue || hasComparisonCue || /\bperformance|returns?|trades?|trading|portfolio\b/.test(low)))
    || (hasMeasurablePoliticsCue && (hasNumberCue || hasClaimCue));
}

function compactSnippetForPrompt(snippetLines = [], maxChars = 180) {
  const text = (Array.isArray(snippetLines) ? snippetLines : [])
    .map((c) => String(c?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trim()}…` : text;
}

function triggerPromptForStyle(styleKey = '', snippetLines = [], presets = null) {
  const cue = compactSnippetForPrompt(snippetLines, 190);
  if (styleKey === 'philosopher_glitch') {
    return `Type: ${presets?.[styleKey]?.label || 'Philosopher glitch style'}. Glitch-style meme portrait/collage inspired by the named thinker, historical figure, or era in: ${cue}`.trim();
  }
  if (styleKey === 'reference_book') {
    return `Type: ${presets?.[styleKey]?.label || 'Book / movie cover reference'}. Cover/poster/screenshot-style visual inspired by the explicit book, movie, show, or artifact reference in: ${cue}`.trim();
  }
  if (styleKey === 'evidence_support') {
    return `Type: ${presets?.[styleKey]?.label || 'Evidence / chart support'}. Evidence card, chart, receipt, or source-backed graphic visualizing the concrete claim/data in: ${cue}`.trim();
  }
  return `Type: ${presets?.[styleKey]?.label || 'Meme commentary'}. Sharp meme/commentary visual for this moment: ${cue}`.trim();
}

function inferStyleKeyForText(text = '', presets = null, requestedStyleKey = '') {
  const requested = pickFirstStyleKey(String(requestedStyleKey || '').trim(), presets || {});
  const hasFigure = hasNamedFigureReference(text);
  const hasMedia = hasSpecificMediaReference(text);
  const hasStudy = hasSpecificStudyReference(text);
  const memeCue = hasAnyPhrase(String(text || '').toLowerCase(), MEME_CUE_TERMS);

  if (requested === 'philosopher_glitch' && hasFigure) return requested;
  if (requested === 'reference_book' && hasMedia) return requested;
  if (requested === 'evidence_support' && hasStudy) return requested;
  if (requested === 'meme_commentary') return requested;

  if (hasMedia) return 'reference_book';
  if (hasStudy) return 'evidence_support';
  if (hasFigure) return 'philosopher_glitch';
  if (memeCue) return 'meme_commentary';
  return 'meme_commentary';
}

function normalizeSectionPrompt(styleKey = '', rawPrompt = '', presets = null) {
  const sk = String(styleKey || '').trim();
  const styleLabel = String(presets?.[sk]?.label || sk || 'Image').trim();
  const stripTypePrefix = (txt = '') => String(txt || '').replace(/^\s*type\s*:\s*[^\n.]+[.:]?\s*/i, '').trim();
  const fallback = stripTypePrefix(stylePrompt(sk, presets || {}));
  const userBody = stripTypePrefix(rawPrompt || '');
  const body = userBody || fallback;
  if (!body) return `Type: ${styleLabel}.`;
  return `Type: ${styleLabel}. ${body}`.trim();
}

function enforceSectionStyleRules(section = {}, presets = null) {
  const snippet = String(section?.transcriptSnippet || '').trim();
  const forcedStyle = inferStyleKeyForText(snippet, presets || {}, section?.styleKey || '');
  const styleKey = pickFirstStyleKey(forcedStyle, presets || {});
  return {
    ...section,
    styleKey,
    category: styleCategory(styleKey, presets || {}),
    defaultCount: styleDefaultCount(styleKey, presets || {}),
    prompt: normalizeSectionPrompt(styleKey, section?.prompt || '', presets || {}),
  };
}

function sectionCenterLine(section = {}) {
  const range = Array.isArray(section?.lineRange) ? section.lineRange : [];
  const a = Number(range?.[0]);
  const b = Number(range?.[1]);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return -1;
  if (!Number.isFinite(a)) return Math.max(0, Math.floor(b));
  if (!Number.isFinite(b)) return Math.max(0, Math.floor(a));
  return Math.max(0, Math.round((a + b) / 2));
}

function collectStrictCueAnchors(transcriptLines = []) {
  const out = {
    evidence_support: [],
    philosopher_glitch: [],
    reference_book: [],
  };

  for (let i = 0; i < transcriptLines.length; i += 1) {
    const prev = String(transcriptLines[i - 1]?.text || '');
    const cur = String(transcriptLines[i]?.text || '');
    const next = String(transcriptLines[i + 1]?.text || '');
    const merged = `${prev} ${cur} ${next}`.trim();
    if (!merged) continue;

    if (hasSpecificStudyReference(merged)) out.evidence_support.push(i);
    if (hasNamedFigureReference(merged)) out.philosopher_glitch.push(i);
    if (hasSpecificMediaReference(merged)) out.reference_book.push(i);
  }

  return out;
}

function uniqueSpacedAnchors(indexes = [], minGapLines = 1) {
  const sorted = [...indexes]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return [];

  const gap = Math.max(1, Number(minGapLines) || 1);
  const out = [];
  for (const idx of sorted) {
    if (!out.length || Math.abs(idx - out[out.length - 1]) >= gap) out.push(idx);
  }
  return out;
}

function convertSectionToAnchorStyle(section = {}, styleKey = '', anchorIdx = 0, transcriptLines = [], presets = null, workflowCfg = null) {
  const maxIx = Math.max(0, transcriptLines.length - 1);
  const center = Math.max(0, Math.min(maxIx, Math.floor(Number(anchorIdx) || 0)));
  const start = Math.max(0, center - 1);
  const end = Math.min(maxIx, center + 1);
  const snippetLines = transcriptLines.slice(start, end + 1);

  const next = {
    ...section,
    styleKey,
    category: styleCategory(styleKey, presets || {}),
    defaultCount: styleDefaultCount(styleKey, presets || {}),
    prompt: triggerPromptForStyle(styleKey, snippetLines, presets || {}),
    startTc: transcriptLines[start]?.tc || section?.startTc || '00:00:00',
    endTc: transcriptLines[end]?.tc || transcriptLines[start]?.tc || section?.endTc || '00:00:00',
    lineRange: [start, end],
    transcriptSnippet: snippetLines.map((c) => `[${c.tc}] ${c.text}`).join('\n'),
    durationSeconds: estimateSectionDurationSeconds(snippetLines, workflowCfg?.recommendations || {}),
  };

  return enforceSectionStyleRules(next, presets || {});
}

function applyStrictCueCoverage(sections = [], transcriptLines = [], presets = null, workflowCfg = null) {
  const out = Array.isArray(sections) ? [...sections] : [];
  if (!out.length || !transcriptLines.length) return out;

  const cuesRaw = collectStrictCueAnchors(transcriptLines);
  const maxIx = Math.max(0, transcriptLines.length - 1);
  const bounds = sectionBoundsFromWorkflow(transcriptLines, workflowCfg?.recommendations || {});
  const minGapLines = Math.max(1, spacingMinutesToLineGap(transcriptLines, bounds.durationSeconds, bounds.minGapMinutes));
  const anchorGap = Math.max(1, Math.floor(minGapLines * 0.6));

  for (const styleKey of ['evidence_support', 'philosopher_glitch', 'reference_book']) {
    const cueAnchors = uniqueSpacedAnchors(cuesRaw?.[styleKey] || [], anchorGap);
    if (!cueAnchors.length) continue;

    // First pass: convert sections already near cue lines (prefer meme sections)
    for (const cueIdx of cueAnchors) {
      const hitIx = out.findIndex((s) => {
        const range = Array.isArray(s?.lineRange) ? s.lineRange : [];
        const a = Number(range?.[0]);
        const b = Number(range?.[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        return cueIdx >= (a - 1) && cueIdx <= (b + 1);
      });
      if (hitIx < 0) continue;
      if (String(out[hitIx]?.styleKey || '') === styleKey) continue;
      if (String(out[hitIx]?.styleKey || '') !== 'meme_commentary') continue;
      out[hitIx] = convertSectionToAnchorStyle(out[hitIx], styleKey, cueIdx, transcriptLines, presets, workflowCfg);
    }

    const desired = Math.max(1, Math.min(cueAnchors.length, bounds.maxCount || cueAnchors.length));
    let current = out.filter((s) => String(s?.styleKey || '') === styleKey).length;
    if (current >= desired) continue;

    for (const cueIdx of cueAnchors) {
      if (current >= desired) break;
      const alreadyCovered = out.some((s) => {
        if (String(s?.styleKey || '') !== styleKey) return false;
        const center = sectionCenterLine(s);
        return center >= 0 && Math.abs(center - cueIdx) <= anchorGap;
      });
      if (alreadyCovered) continue;

      // Prefer converting nearest meme section. If the planner left room under
      // the configured safety cap, append a new strict-trigger section instead
      // of stealing a subjective meme moment. This keeps concrete transcript
      // triggers primary and leaves density constraints mostly for memes.
      if (out.length < (bounds.maxCount || out.length)) {
        const base = out[out.length - 1] || {};
        out.push(convertSectionToAnchorStyle({
          ...base,
          id: `oc-${String(out.length + 1).padStart(2, '0')}`,
          title: styleKey === 'philosopher_glitch'
            ? 'Named thinker / historical trigger'
            : (styleKey === 'reference_book' ? 'Referenced media / book trigger' : 'Evidence / data trigger'),
          sideSuggested: out.length % 2 === 0 ? 'right' : 'left',
          sideSelected: out.length % 2 === 0 ? 'right' : 'left',
        }, styleKey, cueIdx, transcriptLines, presets, workflowCfg));
        current += 1;
        continue;
      }

      // Safety cap is full: convert nearest meme section.
      const candidates = out
        .map((s, ix) => ({ ix, s, center: sectionCenterLine(s) }))
        .filter((row) => row.center >= 0)
        .sort((a, b) => Math.abs(a.center - cueIdx) - Math.abs(b.center - cueIdx));

      const memePick = candidates.find((row) => String(row.s?.styleKey || '') === 'meme_commentary');
      const fallbackPick = candidates[0] || null;
      const pick = memePick || fallbackPick;
      if (!pick) continue;

      out[pick.ix] = convertSectionToAnchorStyle(out[pick.ix], styleKey, cueIdx, transcriptLines, presets, workflowCfg);
      current += 1;
    }
  }

  // Re-apply strict guards and normalize ids/ranges after cue coverage changes.
  return out.map((s, ix) => {
    const styleKey = pickFirstStyleKey(String(s?.styleKey || '').trim(), presets || {});
    const range = clampRange(Number(s?.lineRange?.[0]), Number(s?.lineRange?.[1]), maxIx);
    const snippetLines = transcriptLines.slice(range[0], range[1] + 1);
    const rawPrompt = String(s?.prompt || '');
    const shouldRebuildPrompt = !rawPrompt.trim()
      || /Generate reference-cover style images only/i.test(rawPrompt)
      || /^Section\s+\d+$/i.test(String(s?.title || '').trim());
    const rebuilt = {
      ...s,
      id: String(s?.id || `oc-${String(ix + 1).padStart(2, '0')}`),
      styleKey,
      category: styleCategory(styleKey, presets || {}),
      defaultCount: styleDefaultCount(styleKey, presets || {}),
      prompt: shouldRebuildPrompt
        ? triggerPromptForStyle(styleKey, snippetLines, presets || {})
        : normalizeSectionPrompt(styleKey, rawPrompt || stylePrompt(styleKey, presets || {}), presets || {}),
      startTc: transcriptLines[range[0]]?.tc || s?.startTc || '00:00:00',
      endTc: transcriptLines[range[1]]?.tc || transcriptLines[range[0]]?.tc || s?.endTc || '00:00:00',
      lineRange: range,
      transcriptSnippet: snippetLines.map((c) => `[${c.tc}] ${c.text}`).join('\n'),
      durationSeconds: estimateSectionDurationSeconds(snippetLines, workflowCfg?.recommendations || {}),
    };
    return enforceSectionStyleRules(rebuilt, presets || {});
  });
}

function buildSuggestionSets(lines, pools, presets, opts = {}) {
  const recommendationsCfg = opts.recommendationsCfg && typeof opts.recommendationsCfg === 'object'
    ? opts.recommendationsCfg
    : {};
  const bounds = sectionBoundsFromWorkflow(lines, recommendationsCfg);
  const fallbackMax = Math.max(1, Math.min(64, Math.floor(lines.length / 18) || 1));
  const maxSections = Math.max(1, Math.min(96, Number(opts.maxSections ?? bounds.maxCount ?? fallbackMax)));
  const minGap = Math.max(1, spacingMinutesToLineGap(lines, bounds.durationSeconds, bounds.minGapMinutes));
  const scored = [];

  for (let i = 0; i < lines.length; i += 1) {
    const text = String(lines[i]?.text || '');
    const styleKey = inferStyleKeyForText(text, presets, '');
    const low = text.toLowerCase();
    let score = 1;
    if (styleKey === 'reference_book') score = 5;
    else if (styleKey === 'evidence_support') score = 4;
    else if (styleKey === 'philosopher_glitch') score = 3;
    else if (hasAnyPhrase(low, MEME_CUE_TERMS)) score = 2;
    scored.push({ idx: i, styleKey, score, text: low });
  }

  if (!scored.length) {
    for (let i = 8; i < lines.length; i += 28) {
      scored.push({ idx: i, styleKey: 'meme_commentary', score: 1, text: String(lines[i]?.text || '').toLowerCase() });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const anchors = [];
  for (const cand of scored) {
    if (anchors.length >= maxSections) break;
    if (anchors.some((a) => Math.abs(a.idx - cand.idx) < minGap)) continue;
    anchors.push(cand);
  }

  anchors.sort((a, b) => a.idx - b.idx);
  const usedByCategory = { reference: 0, philosopher: 0, meme: 0, evidence: 0 };
  const sets = [];

  for (let si = 0; si < anchors.length; si += 1) {
    const spec = anchors[si];
    const idx = Math.max(0, spec.idx);
    const start = Math.max(0, idx - 1);
    const end = Math.min(lines.length - 1, idx + 1);
    const chunk = lines.slice(start, end + 1);

    const enforcedStyle = pickFirstStyleKey(inferStyleKeyForText(chunk.map((c) => c.text).join(' '), presets, spec.styleKey), presets);
    const category = styleCategory(enforcedStyle, presets);
    const pool = pools[category] || [];
    const take = styleDefaultCount(enforcedStyle, presets);
    const startIx = usedByCategory[category] || 0;

    const picks = [];
    for (let i = 0; i < take; i += 1) {
      if (!pool.length) break;
      picks.push(pool[(startIx + i) % pool.length]);
    }
    usedByCategory[category] = startIx + take;

    const lineText = String(lines[idx]?.text || '').toLowerCase();
    let side = 'right';
    if (lineText.includes('nover') || lineText.includes('nolan')) side = 'left';
    else if (lineText.includes('james')) side = 'right';
    else side = si % 2 === 0 ? 'right' : 'left';

    sets.push({
      id: `s${String(si + 1).padStart(2, '0')}`,
      styleKey: enforcedStyle,
      category,
      sideSuggested: side,
      prompt: normalizeSectionPrompt(enforcedStyle, stylePrompt(enforcedStyle, presets), presets),
      defaultCount: take,
      durationSeconds: estimateSectionDurationSeconds(chunk, recommendationsCfg),
      startTc: chunk[0]?.tc || '00:00:00',
      endTc: chunk[chunk.length - 1]?.tc || chunk[0]?.tc || '00:00:00',
      lineRange: [chunk[0]?.idx ?? 0, chunk[chunk.length - 1]?.idx ?? 0],
      transcriptSnippet: chunk.map((c) => `[${c.tc}] ${c.text}`).join('\n'),
      candidates: picks,
    });
  }

  return applyStrictCueCoverage(sets, lines, presets, { recommendations: recommendationsCfg });
}

async function buildBootstrapData(paths) {
  const videos = await listVideosInTimelines(paths);
  const transcriptPath = await chooseTranscriptPath(paths);
  const transcriptText = transcriptPath ? await fs.readFile(transcriptPath, 'utf-8') : '';
  const lines = parseTranscriptLines(transcriptText).slice(0, 1200);
  const presets = await getPromptPresets(paths);

  const [referencePool, philosopherPool, memePool, evidencePool] = await Promise.all([
    listCategoryImages(paths, 'reference', 300),
    listCategoryImages(paths, 'philosopher', 300),
    listCategoryImages(paths, 'meme', 300),
    listCategoryImages(paths, 'evidence', 300),
  ]);

  const pools = {
    reference: referencePool,
    philosopher: philosopherPool,
    meme: memePool,
    evidence: evidencePool,
  };

  return {
    ok: true,
    source: {
      rawVideoPath: videos[0]?.path || (fsSync.existsSync(paths.rawVideoDefault) ? paths.rawVideoDefault : ''),
      transcriptPath: transcriptPath || '(not found)',
      imageLibraryRoot: paths.imageLibraryRoot,
      storageRoot: paths.storageRoot,
      projectsRoot: paths.projectsRoot,
      ingestRoot: paths.ingestRoot,
    },
    transcript: {
      totalLines: lines.length,
      lines,
    },
    promptPresets: presets,
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    poolItems: pools,
    suggestionSets: buildSuggestionSets(lines, pools, presets, {
      recommendationsCfg: defaultWorkflowConfig().recommendations,
    }),
  };
}

async function buildRecommendationsHeuristic(paths, transcriptLines = [], workflowConfig = null) {
  const lines = (Array.isArray(transcriptLines) ? transcriptLines : []).map((l, i) => ({
    idx: Number.isFinite(Number(l?.idx)) ? Number(l.idx) : i,
    tc: String(l?.tc || secondsToTc(i * 4)),
    text: String(l?.text || ''),
  })).filter((l) => l.text.trim().length > 0);

  if (!lines.length) {
    return {
      ok: true,
      transcript: { totalLines: 0, lines: [] },
      promptPresets: await getPromptPresets(paths),
      poolItems: { reference: [], philosopher: [], meme: [], evidence: [] },
      pools: { reference: 0, philosopher: 0, meme: 0, evidence: 0 },
      suggestionSets: [],
    };
  }

  const presets = await getPromptPresets(paths);
  const [referencePool, philosopherPool, memePool, evidencePool] = await Promise.all([
    listCategoryImages(paths, 'reference', 300),
    listCategoryImages(paths, 'philosopher', 300),
    listCategoryImages(paths, 'meme', 300),
    listCategoryImages(paths, 'evidence', 300),
  ]);

  const pools = {
    reference: referencePool,
    philosopher: philosopherPool,
    meme: memePool,
    evidence: evidencePool,
  };

  const wf = normalizeWorkflowConfig(workflowConfig || {}).recommendations;
  const bounds = sectionBoundsFromWorkflow(lines, wf);
  const minCount = bounds.minCount;
  const maxCount = bounds.maxCount;
  const minGapLines = Math.max(1, spacingMinutesToLineGap(lines, bounds.durationSeconds, bounds.minGapMinutes));
  const maxGapLines = Math.max(2, spacingMinutesToLineGap(lines, bounds.durationSeconds, bounds.maxGapMinutes));
  let suggestionSets = buildSuggestionSets(lines, pools, presets, {
    maxSections: maxCount,
    recommendationsCfg: wf,
  });
  suggestionSets = suggestionSets.slice(0, maxCount);

  if (suggestionSets.length < minCount && lines.length > 0) {
    const seen = new Set(suggestionSets.map((s) => `${s.startTc}-${s.endTc}`));
    const centers = suggestionSets
      .map((s) => {
        const a = Number(s?.lineRange?.[0]);
        const b = Number(s?.lineRange?.[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        return Math.round((a + b) / 2);
      })
      .filter((v) => Number.isFinite(v));
    const fallbackGap = Math.max(2, maxGapLines);
    for (let i = Math.max(1, Math.floor(fallbackGap / 2)); i < lines.length && suggestionSets.length < minCount; i += fallbackGap) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length - 1, i + 1);
      const center = Math.round((start + end) / 2);
      if (centers.some((c) => Math.abs(c - center) < minGapLines)) continue;
      const key = `${lines[start]?.tc || '00:00:00'}-${lines[end]?.tc || '00:00:00'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      centers.push(center);
      suggestionSets.push({
        id: `f-${suggestionSets.length + 1}`,
        styleKey: 'reference_book',
        category: 'reference',
        sideSuggested: suggestionSets.length % 2 === 0 ? 'right' : 'left',
        prompt: stylePrompt('reference_book', presets),
        defaultCount: 2,
        durationSeconds: estimateSectionDurationSeconds(lines.slice(start, end + 1), wf),
        startTc: lines[start]?.tc || '00:00:00',
        endTc: lines[end]?.tc || lines[start]?.tc || '00:00:00',
        lineRange: [lines[start]?.idx ?? start, lines[end]?.idx ?? end],
        transcriptSnippet: lines.slice(start, end + 1).map((c) => `[${c.tc}] ${c.text}`).join('\n'),
        candidates: (pools.reference || []).slice(0, 2),
      });
    }
  }

  return {
    ok: true,
    transcript: { totalLines: lines.length, lines },
    promptPresets: presets,
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    poolItems: pools,
    suggestionSets,
  };
}

function parseJsonObjectLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // continue
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // continue
    }
  }

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    } catch {
      // continue
    }
  }
  return null;
}

function makeJsonStrictInstruction(base = '') {
  return [
    String(base || '').trim(),
    '',
    'CRITICAL OUTPUT CONTRACT:',
    '- Return ONLY a complete, valid JSON object. No markdown, prose, comments, or trailing text.',
    '- Use this exact top-level shape: {"sections":[...]}',
    '- Every string must be JSON-escaped and closed. Do not include literal newlines inside string values.',
    '- Keep each prompt field under 180 characters so the response cannot be truncated.',
    '- If you cannot finish the full list, return fewer complete sections. Never return partial JSON.',
  ].filter(Boolean).join('\n');
}

async function repairGatewayJsonWithAgent({
  sessionKey,
  model,
  thinking = 'off',
  badText,
  originalPrompt,
  idempotencyKey,
  timeoutMs = 240000,
}) {
  const repairPrompt = [
    'Repair the following invalid/truncated JSON into one complete valid JSON object.',
    'Return ONLY valid JSON. No markdown, no explanation.',
    'Required top-level shape: {"sections":[{"lineStart":0,"lineEnd":1,"title":"...","styleKey":"...","side":"left|right","prompt":"..."}]}',
    'Rules: keep only complete sections you can recover; discard any unfinished object/string; prompts under 180 chars.',
    '',
    'Original task context:',
    String(originalPrompt || '').slice(0, 5000),
    '',
    'Invalid JSON to repair:',
    String(badText || '').slice(0, 12000),
  ].join('\n');

  return runGatewayAgentForJson({
    sessionKey,
    model,
    thinking,
    message: repairPrompt,
    idempotencyKey: `${String(idempotencyKey || `podpics-json-repair-${Date.now()}`)}-repair`,
    timeoutMs,
    maxJsonAttempts: 1,
  });
}

function contentBlocksToText(content) {
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

function extractLastAssistantText(historyResult) {
  const messages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const txt = contentBlocksToText(m.content);
    if (txt) return txt;
  }
  return '';
}

async function gatewayCallJson(method, params = {}, timeoutMs = 240000) {
  const timeout = Math.max(10_000, Number(timeoutMs) || 240000);
  const args = ['gateway', 'call', '--json', method, '--timeout', String(timeout), '--params', JSON.stringify(params || {})];
  const { stdout, stderr } = await execFileAsync('openclaw', args, {
    timeout,
    maxBuffer: 12_000_000,
  });
  const outText = String(stdout || '').trim();
  const out = safeParseJson(outText, null);
  if (!out || typeof out !== 'object') {
    throw new Error(`Gateway call ${method} returned non-JSON output`);
  }
  if (out.ok === false && out.error) {
    const msg = typeof out.error === 'string'
      ? out.error
      : (out.error?.message || JSON.stringify(out.error));
    throw new Error(`Gateway ${method} error: ${msg}`);
  }
  if (stderr && String(stderr).trim()) {
    // keep stderr non-fatal, but include in output for debugging if needed.
    out.__stderr = String(stderr).trim();
  }
  return out;
}

function buildEphemeralSessionKey(prefix, id) {
  const cleanPrefix = String(prefix || 'podpics').replace(/[^a-zA-Z0-9:_-]+/g, '-');
  const cleanId = String(id || randomUUID()).replace(/[^a-zA-Z0-9:_-]+/g, '-');
  return `agent:main:${cleanPrefix}-${cleanId}`;
}

async function ensureGatewaySessionModel(sessionKey, modelId) {
  const model = String(modelId || '').trim();
  if (!model) return;
  await gatewayCallJson('sessions.patch', {
    key: sessionKey,
    model,
  }, 60_000);
}

async function runGatewayAgentForJson({
  sessionKey,
  model,
  thinking = 'off',
  message,
  idempotencyKey,
  timeoutMs = 420000,
  maxJsonAttempts = 3,
}) {
  if (!sessionKey) throw new Error('Missing session key for gateway run');
  if (!message) throw new Error('Missing message for gateway run');

  if (model) {
    await ensureGatewaySessionModel(sessionKey, model);
  }

  const baseId = String(idempotencyKey || `podpics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let lastText = '';
  let lastRunId = '';
  const attempts = Math.max(1, Math.min(4, Number(maxJsonAttempts || 3)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptMessage = attempt === 1
      ? makeJsonStrictInstruction(message)
      : makeJsonStrictInstruction([
        message,
        '',
        `Previous attempt returned invalid/truncated JSON. Retry ${attempt}/${attempts}.`,
        'Return fewer sections if needed, but the JSON object must be complete and parseable.',
        'Previous invalid response excerpt:',
        String(lastText || '').slice(0, 1200),
      ].join('\n'));

    const run = await gatewayCallJson('agent', {
      message: attemptMessage,
      sessionKey,
      thinking: String(thinking || 'off'),
      idempotencyKey: `${baseId}-json-${attempt}`,
    }, 60_000);

    const runId = String(run?.runId || '').trim();
    if (!runId) throw new Error('Gateway run did not return runId');
    lastRunId = runId;

    await gatewayCallJson('agent.wait', {
      runId,
      timeoutMs: Math.max(60_000, Number(timeoutMs) || 420000),
    }, Math.max(70_000, Number(timeoutMs) || 420000));

    const hist = await gatewayCallJson('chat.history', {
      sessionKey,
      limit: 16,
    }, 60_000);

    lastText = extractLastAssistantText(hist);
    const parsed = parseJsonObjectLoose(lastText);
    if (parsed && typeof parsed === 'object') {
      return { runId, parsed, rawText: lastText, jsonAttempts: attempt };
    }

    if (attempt < attempts && lastText) {
      try {
        const repaired = await repairGatewayJsonWithAgent({
          sessionKey,
          model,
          thinking,
          badText: lastText,
          originalPrompt: message,
          idempotencyKey: `${baseId}-json-${attempt}`,
          timeoutMs: Math.min(Math.max(90_000, Number(timeoutMs) || 240000), 240000),
        });
        if (repaired?.parsed && typeof repaired.parsed === 'object') {
          return { ...repaired, jsonAttempts: `${attempt}+repair` };
        }
      } catch {
        // Continue to a clean retry. The final error below includes the invalid excerpt.
      }
    }
  }

  throw new Error(`Gateway agent response was not valid JSON after ${attempts} attempts. Last response: ${lastText.slice(0, 240)}`);
}

function nearestLineIndexByTc(lines, tc) {
  const target = String(tc || '').trim();
  if (!target) return -1;
  const [hh, mm, ss] = target.split(':').map((n) => Number(n || 0));
  const targetSec = hh * 3600 + mm * 60 + ss;
  if (!Number.isFinite(targetSec)) return -1;

  let bestIx = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lines.length; i += 1) {
    const t = String(lines[i]?.tc || '00:00:00');
    const [h, m, s] = t.split(':').map((n) => Number(n || 0));
    const cur = h * 3600 + m * 60 + s;
    if (!Number.isFinite(cur)) continue;
    const d = Math.abs(cur - targetSec);
    if (d < bestDelta) {
      bestDelta = d;
      bestIx = i;
    }
  }
  return bestIx;
}

function clampRange(start, end, maxIx) {
  if (!Number.isFinite(start) && !Number.isFinite(end)) return [0, Math.min(1, maxIx)];
  const a = Number.isFinite(start) ? Math.max(0, Math.min(maxIx, Math.floor(start))) : Math.max(0, Math.min(maxIx, Math.floor(end || 0)));
  const b = Number.isFinite(end) ? Math.max(0, Math.min(maxIx, Math.floor(end))) : a;
  return [Math.min(a, b), Math.max(a, b)];
}

function pickFirstStyleKey(styleKey, presets) {
  if (styleKey && presets?.[styleKey]) return styleKey;
  const keys = Object.keys(presets || {});
  return keys.includes('reference_book') ? 'reference_book' : (keys[0] || 'reference_book');
}

function normalizeOpenClawSections(rawSections, transcriptLines, presets, workflowCfg) {
  const src = Array.isArray(rawSections) ? rawSections : [];
  const maxIx = Math.max(0, transcriptLines.length - 1);
  const bounds = sectionBoundsFromWorkflow(transcriptLines, workflowCfg?.recommendations || {});
  const minCount = bounds.minCount;
  const maxCount = bounds.maxCount;
  const minGapLines = Math.max(1, spacingMinutesToLineGap(transcriptLines, bounds.durationSeconds, bounds.minGapMinutes));
  const maxGapLines = Math.max(2, spacingMinutesToLineGap(transcriptLines, bounds.durationSeconds, bounds.maxGapMinutes));

  const out = [];
  const selectedCenters = [];
  for (let i = 0; i < src.length && out.length < maxCount; i += 1) {
    const row = src[i] || {};

    let start = Number.isFinite(Number(row.lineStart)) ? Number(row.lineStart) : NaN;
    let end = Number.isFinite(Number(row.lineEnd)) ? Number(row.lineEnd) : NaN;

    if (!Number.isFinite(start) && row.startTc) start = nearestLineIndexByTc(transcriptLines, row.startTc);
    if (!Number.isFinite(end) && row.endTc) end = nearestLineIndexByTc(transcriptLines, row.endTc);

    const range = clampRange(start, end, maxIx);
    const center = Math.round((range[0] + range[1]) / 2);
    if (selectedCenters.some((c) => Math.abs(c - center) < minGapLines)) {
      continue;
    }

    const styleKey = pickFirstStyleKey(String(row.styleKey || '').trim(), presets);
    const category = styleCategory(styleKey, presets);
    const snippetLines = transcriptLines.slice(range[0], range[1] + 1);

    const normalized = enforceSectionStyleRules({
      id: `oc-${String(out.length + 1).padStart(2, '0')}`,
      title: String(row.title || `Section ${out.length + 1}`),
      styleKey,
      category,
      sideSuggested: String(row.side || '').toLowerCase() === 'left' ? 'left' : 'right',
      sideSelected: String(row.side || '').toLowerCase() === 'left' ? 'left' : 'right',
      prompt: String(row.prompt || stylePrompt(styleKey, presets)).trim() || stylePrompt(styleKey, presets),
      defaultCount: styleDefaultCount(styleKey, presets),
      durationSeconds: estimateSectionDurationSeconds(snippetLines, workflowCfg?.recommendations || {}),
      startTc: transcriptLines[range[0]]?.tc || '00:00:00',
      endTc: transcriptLines[range[1]]?.tc || transcriptLines[range[0]]?.tc || '00:00:00',
      lineRange: range,
      transcriptSnippet: snippetLines.map((c) => `[${c.tc}] ${c.text}`).join('\n'),
      candidates: [],
      selectedCandidateId: null,
    }, presets);
    out.push(normalized);
    selectedCenters.push(center);
  }

  if (out.length < minCount && transcriptLines.length > 0) {
    const gap = Math.max(2, maxGapLines);
    for (let i = Math.max(1, Math.floor(gap / 2)); i < transcriptLines.length && out.length < minCount; i += gap) {
      const start = Math.max(0, i - 1);
      const end = Math.min(transcriptLines.length - 1, i + 1);
      const center = Math.round((start + end) / 2);
      if (selectedCenters.some((c) => Math.abs(c - center) < minGapLines)) continue;
      const styleKey = pickFirstStyleKey('reference_book', presets);
      const snippetLines = transcriptLines.slice(start, end + 1);
      const normalized = enforceSectionStyleRules({
        id: `oc-${String(out.length + 1).padStart(2, '0')}`,
        title: `Section ${out.length + 1}`,
        styleKey,
        category: styleCategory(styleKey, presets),
        sideSuggested: out.length % 2 === 0 ? 'right' : 'left',
        sideSelected: out.length % 2 === 0 ? 'right' : 'left',
        prompt: stylePrompt(styleKey, presets),
        defaultCount: styleDefaultCount(styleKey, presets),
        durationSeconds: estimateSectionDurationSeconds(snippetLines, workflowCfg?.recommendations || {}),
        startTc: transcriptLines[start]?.tc || '00:00:00',
        endTc: transcriptLines[end]?.tc || transcriptLines[start]?.tc || '00:00:00',
        lineRange: [start, end],
        transcriptSnippet: snippetLines.map((c) => `[${c.tc}] ${c.text}`).join('\n'),
        candidates: [],
        selectedCandidateId: null,
      }, presets);
      out.push(normalized);
      selectedCenters.push(center);
    }
  }

  const calibrated = applyStrictCueCoverage(out, transcriptLines, presets, workflowCfg);
  return calibrated.slice(0, maxCount);
}

function fillPromptTemplate(template = '', vars = {}) {
  return String(template || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => String(vars?.[key] ?? ''));
}

function buildOpenClawRecommendationPrompt(lines, workflowCfg, presets, customPrompt = '') {
  const styleKeys = Object.keys(presets || {});
  const firstStyleKey = styleKeys[0] || 'reference_book';
  const lineSample = lines.slice(0, 1400).map((l) => `${l.idx}\t${l.tc}\t${String(l.text || '').replace(/\s+/g, ' ').trim()}`).join('\n');
  const bounds = sectionBoundsFromWorkflow(lines, workflowCfg?.recommendations || {});
  const minCount = bounds.minCount;
  const maxCount = bounds.maxCount;
  const targetCount = bounds.targetCount;
  const minGapMinutes = bounds.minGapMinutes;
  const maxGapMinutes = bounds.maxGapMinutes;
  const durationMinutes = bounds.durationMinutes;
  const promptTemplate = String(customPrompt || workflowCfg?.recommendations?.customPrompt || DEFAULT_SECTION_PLANNER_PROMPT_TEMPLATE).trim()
    || DEFAULT_SECTION_PLANNER_PROMPT_TEMPLATE;

  return fillPromptTemplate(promptTemplate, {
    FIRST_STYLE_KEY: firstStyleKey,
    STYLE_KEYS: styleKeys.join(', ') || 'reference_book',
    DURATION_MINUTES: durationMinutes.toFixed(2),
    MAX_GAP_MINUTES: maxGapMinutes.toFixed(2),
    MIN_GAP_MINUTES: minGapMinutes.toFixed(2),
    MIN_COUNT: String(minCount),
    MAX_COUNT: String(maxCount),
    TARGET_COUNT: String(targetCount),
    TRANSCRIPT_LINES: lineSample,
  });
}

function imageTypeRule(styleKey = '') {
  const key = String(styleKey || '').trim();
  if (key === 'reference_book') {
    return 'Use this style only when the transcript explicitly references a specific movie/book/cover; reflect that exact reference.';
  }
  if (key === 'philosopher_glitch') {
    return 'Use this style only when a real named historical/philosophical figure is explicitly mentioned.';
  }
  if (key === 'evidence_support') {
    return 'Use this style only when a concrete study/research/data claim is present; render chart/diagram/quote-card support.';
  }
  return 'Meme style is the flexible fallback: witty, sharp, and aligned with James/Nolan taste (not generic slapstick).';
}

function buildImageGenPrompt(section, workflowCfg = null, referenceExamples = [], modelInfo = null) {
  const styleLabel = String((DEFAULT_PROMPTS?.[section?.styleKey || '']?.label) || section?.styleKey || 'image').trim();
  const requestedModel = String(modelInfo?.requested || workflowCfg?.images?.model || '').trim() || '(gateway default model routing)';
  const routedModel = String(modelInfo?.routed || requestedModel || '').trim() || '(gateway default model routing)';
  const refs = Array.isArray(referenceExamples) ? referenceExamples : [];
  const refNames = refs.map((r) => String(r?.name || '').trim()).filter(Boolean).slice(0, IMAGE_REFERENCE_MAX);
  const refBlock = refNames.length
    ? `Reference images attached are STYLE INSPIRATION ONLY (color palette, typography mood, contrast level). Do NOT replicate their layout, do NOT combine panels from them into a grid, and do NOT produce a sheet of variants. Style cues from: ${refNames.join(' | ')}`
    : 'Reference images: none available for this style category.';
  const template = String(workflowCfg?.images?.systemPromptTemplate || DEFAULT_IMAGE_SYSTEM_PROMPT_TEMPLATE).trim() || DEFAULT_IMAGE_SYSTEM_PROMPT_TEMPLATE;
  const vars = {
    '{{STYLE_LABEL}}': styleLabel,
    '{{STYLE_KEY}}': String(section?.styleKey || ''),
    '{{TYPE_RULE}}': imageTypeRule(section?.styleKey || ''),
    '{{SECTION_TITLE}}': String(section?.title || ''),
    '{{DIRECTION}}': String(section?.prompt || ''),
    '{{REFERENCE_BLOCK}}': refBlock,
    '{{TRANSCRIPT_SNIPPET}}': String(section?.transcriptSnippet || ''),
    '{{REQUESTED_MODEL}}': requestedModel,
    '{{ROUTED_MODEL}}': routedModel,
  };
  return Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(String(v ?? '')), template);
}

function normalizeImagePathsFromAgentResponse(parsed) {
  const list = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (s.startsWith('/')) list.push(s);
  };

  if (Array.isArray(parsed?.paths)) parsed.paths.forEach(add);
  if (Array.isArray(parsed?.media)) parsed.media.forEach(add);
  if (parsed?.path) add(parsed.path);
  return [...new Set(list)];
}

function collectAbsolutePathsDeep(value, out = new Set(), depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === 'string') {
    const s = String(value || '').trim();
    if (s.startsWith('/')) out.add(s);
    // Capture embedded absolute paths from tool-result/inter-session text payloads.
    const embeddedAbs = s.match(/\/[A-Za-z0-9._\-\/]+?\.(?:png|jpe?g|webp|avif|gif)/gi) || [];
    for (const p of embeddedAbs) out.add(String(p || '').trim());
    const mediaHits = s.match(/MEDIA:([^\n]+)/g) || [];
    for (const hit of mediaHits) {
      const p = String(hit || '').replace(/^MEDIA:/, '').trim();
      if (p.startsWith('/')) out.add(p);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAbsolutePathsDeep(v, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectAbsolutePathsDeep(v, out, depth + 1);
  }
  return out;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectImageTaskPaths(taskId = '', sessionKey = '', timeoutMs = IMAGE_SECTION_TIMEOUT_MS) {
  const id = String(taskId || '').trim();
  if (!id) return { paths: [], task: null, error: '' };

  const deadline = Date.now() + Math.max(30_000, Number(timeoutMs) || IMAGE_SECTION_TIMEOUT_MS);
  let task = null;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const out = await gatewayCallJson('tasks.get', { taskId: id }, 30_000);
      task = out?.task || out || null;
      const status = String(task?.status || '').toLowerCase();
      if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled') break;
    } catch (err) {
      lastError = String(err?.message || err);
    }
    await sleep(IMAGE_TASK_POLL_MS);
  }

  if (task && !['completed', 'failed', 'cancelled', 'canceled'].includes(String(task.status || '').toLowerCase())) {
    return {
      paths: [],
      task,
      error: `image generation timed out while task was still ${String(task.status || 'running')}`,
    };
  }

  const taskPaths = [...collectAbsolutePathsDeep(task)];
  const lookupKeys = [
    sessionKey,
    task?.sessionKey,
    task?.childSessionKey,
    task?.ownerKey,
    task?.runId,
    task?.taskId ? `image_generate:${task.taskId}` : '',
    id ? `image_generate:${id}` : '',
  ].map((v) => String(v || '').trim()).filter(Boolean);

  let transcriptPaths = [];
  for (const key of lookupKeys) {
    try {
      const hist = await gatewayCallJson('chat.history', { key, limit: 20 }, 30_000);
      transcriptPaths = [...transcriptPaths, ...collectAbsolutePathsDeep(hist)];
    } catch {}
  }

  let recentMediaPaths = [];
  if (String(task?.status || '').toLowerCase() === 'completed') {
    const startedAt = Number(task?.startedAt || task?.createdAt || 0);
    const endedAt = Number(task?.endedAt || task?.updatedAt || Date.now());
    recentMediaPaths = await listGeneratedMediaPathsBetween(startedAt - 10_000, endedAt + 10_000).catch(() => []);
  }

  const paths = [...new Set([...taskPaths, ...transcriptPaths, ...recentMediaPaths])].filter((p) => IMAGE_EXTS.has(path.extname(p).toLowerCase()));
  const status = String(task?.status || '').toLowerCase();
  const error = status === 'failed'
    ? String(task?.error || task?.terminalSummary || task?.progressSummary || 'image generation failed')
    : lastError;
  return { paths, task, error };
}

async function listGeneratedMediaPathsBetween(startMs = 0, endMs = Date.now()) {
  const dir = path.join(process.env.HOME || '/root', '.openclaw', 'media', 'tool-image-generation');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const ent of entries) {
    if (!ent?.isFile?.()) continue;
    if (!IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
    const full = path.join(dir, ent.name);
    const st = await fs.stat(full).catch(() => null);
    if (!st) continue;
    const mtime = Number(st.mtimeMs || 0);
    if (mtime >= startMs && mtime <= endMs) out.push(full);
  }
  return out.sort();
}

function parseProviderModel(modelRaw = '') {
  const model = String(modelRaw || '').trim();
  if (!model) return { provider: '', model: '' };
  const slashIx = model.indexOf('/');
  if (slashIx <= 0) return { provider: '', model };
  return {
    provider: model.slice(0, slashIx).trim(),
    model: model.slice(slashIx + 1).trim(),
  };
}

function normalizeImageModelOverride(modelRaw = '') {
  const requested = String(modelRaw || '').trim();
  if (!requested) {
    return {
      requested,
      routed: '',
      warning: '',
    };
  }

  const bareOpenAiImageModel = /^gpt-image-(?:2|1\.5|1(?:-mini)?)$/i;
  if (bareOpenAiImageModel.test(requested)) {
    return {
      requested,
      routed: `openai/${requested.toLowerCase()}`,
      warning: '',
    };
  }

  if (!looksLikeNonImageModel(requested)) {
    return {
      requested,
      routed: requested,
      warning: '',
    };
  }

  return {
    requested,
    routed: 'openai/gpt-image-2',
    warning: `Requested model \`${requested}\` is not image-specific. Routed to \`openai/gpt-image-2\`.`,
  };
}

function looksLikeNonImageModel(modelRaw = '') {
  const model = String(modelRaw || '').trim();
  if (!model) return false;
  const low = model.toLowerCase();
  if (low.includes('image')) return false;
  return /gpt-5|gpt-4\.?1|claude|sonnet|haiku|llama|deepseek|qwen(?!.*image)/i.test(model);
}

async function generateSectionCandidatesViaOpenClaw(section, workflowCfg, sectionIndex = 0, opts = {}) {
  const imgCfg = workflowCfg.images || {};
  const sessionKey = IMAGE_MAIN_SESSION_KEY;

  const count = Math.max(1, Math.min(6, Number(imgCfg.countPerSection || section.defaultCount || 2)));
  const requestedModelRaw = String(imgCfg.model || '').trim();
  const modelDecision = normalizeImageModelOverride(requestedModelRaw);
  const modelRequested = String(modelDecision.requested || '').trim();
  const modelRouted = String(modelDecision.routed || '').trim();
  const referenceExamples = Array.isArray(opts?.referenceExamples) ? opts.referenceExamples : [];
  const referenceImagePaths = referenceExamples
    .map((r) => String(r?.path || '').trim())
    .filter((p) => p.startsWith('/'))
    .slice(0, IMAGE_REFERENCE_MAX);

  const prompt = buildImageGenPrompt(section, workflowCfg || {}, referenceExamples, {
    requested: modelRequested,
    routed: modelRouted,
  });
  const toolArgs = {
    prompt,
    count,
    ...(imgCfg.size ? { size: String(imgCfg.size) } : {}),
    ...(imgCfg.aspectRatio ? { aspectRatio: String(imgCfg.aspectRatio) } : {}),
    ...(modelRouted ? { model: modelRouted } : {}),
    ...(referenceImagePaths.length ? { images: referenceImagePaths } : {}),
  };

  const requested = parseProviderModel(modelRequested);
  const routed = parseProviderModel(modelRouted);
  const baseMeta = {
    route: 'openclaw:image_generate',
    providerRequested: requested.provider || '(gateway default provider)',
    modelRequested: modelRequested || '(gateway default model routing)',
    providerRouted: routed.provider || requested.provider || '(gateway default provider)',
    modelRouted: modelRouted || '(gateway default model routing)',
    modelHintWarning: String(modelDecision.warning || '').trim(),
    referenceImagesUsed: referenceExamples
      .map((r) => String(r?.name || '').trim())
      .filter(Boolean)
      .slice(0, IMAGE_REFERENCE_MAX),
    promptUsed: prompt,
    sectionPrompt: String(section?.prompt || '').trim(),
    sectionStyleKey: String(section?.styleKey || '').trim(),
    sectionTitle: String(section?.title || '').trim(),
    countRequested: count,
    sizeRequested: String(imgCfg.size || '').trim(),
    aspectRatioRequested: String(imgCfg.aspectRatio || '').trim(),
    sessionKey,
    ephemeral: false,
  };

  return runImageGenerationSerial(async () => {
    try {
      const invoke = await gatewayCallJson('tools.invoke', {
        name: 'image_generate',
        sessionKey,
        idempotencyKey: `podpics-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        args: toolArgs,
      }, IMAGE_SECTION_TIMEOUT_MS);

    const details = invoke?.output?.details && typeof invoke.output.details === 'object'
      ? invoke.output.details
      : {};

    const direct = Array.isArray(details?.paths)
      ? invoke.output.details.paths.map((p) => String(p || '').trim()).filter((p) => p.startsWith('/'))
      : [];

    const contentText = contentBlocksToText(invoke?.output?.content || []);
    const mediaFromText = (contentText.match(/MEDIA:([^\n]+)/g) || [])
      .map((s) => String(s || '').replace(/^MEDIA:/, '').trim())
      .filter((p) => p.startsWith('/'));

    const deepDiscovered = [...collectAbsolutePathsDeep(invoke?.output)];

    const taskId = String(details?.taskId || details?.task?.taskId || '').trim();
    const asyncResult = details?.async || taskId
      ? await collectImageTaskPaths(taskId, sessionKey, IMAGE_SECTION_TIMEOUT_MS)
      : { paths: [], error: '' };
    const asyncPaths = asyncResult.paths || [];
    const paths = [...new Set([...direct, ...mediaFromText, ...deepDiscovered, ...asyncPaths])];

    const providerUsed = String(
      details.provider
      || details.providerId
      || details.providerName
      || ''
    ).trim();
    const modelUsed = String(
      details.model
      || details.modelId
      || details.modelName
      || modelRouted
      || ''
    ).trim();

      return {
        ok: true,
        paths,
        error: String(asyncResult.error || ''),
        sessionKey,
        ephemeral: false,
        meta: {
          ...baseMeta,
          providerUsed: providerUsed || baseMeta.providerRouted || baseMeta.providerRequested,
          modelUsed: modelUsed || baseMeta.modelRouted || baseMeta.modelRequested,
        },
      };
    } catch (err) {
      return {
        ok: false,
        paths: [],
        error: String(err?.message || err),
        sessionKey,
        ephemeral: false,
        meta: {
          ...baseMeta,
          providerUsed: baseMeta.providerRouted || baseMeta.providerRequested,
          modelUsed: baseMeta.modelRouted || baseMeta.modelRequested,
        },
      };
    }
  });
}

function toApiImageUrl(p) {
  return `${BASE}/api/image?path=${encodeURIComponent(p)}`;
}

function safeGeneratedAssetGroupId(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return 'session';
  return s.replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 80) || 'session';
}

async function persistGeneratedImagePath(srcPath, paths, groupId = 'session', sectionIndex = 0, candidateIndex = 0) {
  const src = normalizeAbs(srcPath || '');
  if (!src) return '';
  if (inAllowedDir(src, paths.projectsRoot)) return src;

  const extRaw = String(path.extname(src) || '').toLowerCase();
  const ext = IMAGE_EXTS.has(extRaw) ? extRaw : '.png';
  const safeGroup = safeGeneratedAssetGroupId(groupId);
  const outDir = path.join(paths.projectsRoot, '_generated', safeGroup);
  const outName = `s${sectionIndex + 1}-c${candidateIndex + 1}-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
  const outPath = path.join(outDir, outName);

  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.copyFile(src, outPath);
    return outPath;
  } catch {
    return src;
  }
}

async function persistGeneratedImagePaths(srcPaths = [], paths, groupId = 'session', sectionIndex = 0) {
  const out = [];
  const items = Array.isArray(srcPaths) ? srcPaths : [];
  for (let i = 0; i < items.length; i += 1) {
    const persisted = await persistGeneratedImagePath(items[i], paths, groupId, sectionIndex, i);
    if (persisted) out.push(persisted);
  }
  return [...new Set(out)];
}

async function buildRecommendationsOpenClaw(paths, transcriptLines = [], workflowConfig = null, opts = {}) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : () => {};
  const customPrompt = String(opts?.customPrompt || '').trim();
  const wf = normalizeWorkflowConfig(workflowConfig || {});
  const lines = (Array.isArray(transcriptLines) ? transcriptLines : []).map((l, i) => ({
    idx: Number.isFinite(Number(l?.idx)) ? Number(l.idx) : i,
    tc: String(l?.tc || secondsToTc(i * 4)),
    text: String(l?.text || ''),
  })).filter((l) => l.text.trim().length > 0);

  const presets = await getPromptPresets(paths);
  const [referencePool, philosopherPool, memePool, evidencePool] = await Promise.all([
    listCategoryImages(paths, 'reference', 300),
    listCategoryImages(paths, 'philosopher', 300),
    listCategoryImages(paths, 'meme', 300),
    listCategoryImages(paths, 'evidence', 300),
  ]);

  const pools = {
    reference: referencePool,
    philosopher: philosopherPool,
    meme: memePool,
    evidence: evidencePool,
  };

  if (!lines.length) {
    const emptyOut = {
      ok: true,
      transcript: { totalLines: 0, lines: [] },
      promptPresets: presets,
      poolItems: pools,
      pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
      suggestionSets: [],
      engineUsed: 'openclaw',
    };
    onProgress({
      phase: 'sections-ready',
      base: {
        transcript: emptyOut.transcript,
        promptPresets: emptyOut.promptPresets,
        poolItems: emptyOut.poolItems,
        pools: emptyOut.pools,
        engineUsed: 'openclaw',
      },
      suggestionSets: [],
      total: 0,
      completed: 0,
    });
    return emptyOut;
  }

  const recCfg = wf.recommendations || {};
  const useMain = String(recCfg.sessionMode || 'ephemeral').toLowerCase() === 'main';
  const recSessionKey = useMain
    ? String(recCfg.sessionKey || 'agent:main:podpics-recommendations').trim()
    : buildEphemeralSessionKey('podpics-recommendations', Date.now());

  const prompt = buildOpenClawRecommendationPrompt(lines, wf, presets, customPrompt);
  let run;
  try {
    run = await runGatewayAgentForJson({
      sessionKey: recSessionKey,
      model: String(recCfg.model || '').trim(),
      thinking: String(recCfg.thinking || 'off'),
      message: prompt,
      idempotencyKey: `podpics-rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timeoutMs: 420000,
      maxJsonAttempts: 3,
    });
  } catch (err) {
    const fallback = await buildRecommendationsHeuristic(paths, lines, wf);
    return {
      ...fallback,
      engineUsed: 'openclaw-fallback-heuristic',
      warning: `OpenClaw planner failed after JSON retry/repair; used heuristic sections instead: ${String(err?.message || err)}`,
    };
  } finally {
    if (!useMain) {
      await gatewayCallJson('sessions.delete', { key: recSessionKey, deleteTranscript: true }).catch(() => {});
    }
  }

  const rawSections = Array.isArray(run.parsed?.sections)
    ? run.parsed.sections
    : (Array.isArray(run.parsed) ? run.parsed : []);

  const sections = normalizeOpenClawSections(rawSections, lines, presets, wf).map((s) => ({
    ...s,
    loading: true,
  }));

  const base = {
    transcript: { totalLines: lines.length, lines },
    promptPresets: presets,
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    poolItems: pools,
    engineUsed: 'openclaw',
  };

  onProgress({
    phase: 'sections-ready',
    base,
    suggestionSets: sections.map((s) => ({ ...s, candidates: Array.isArray(s.candidates) ? s.candidates : [] })),
    total: sections.length,
    completed: 0,
  });

  if (String(wf.images?.engine || 'pool').toLowerCase() !== 'openclaw') {
    for (const sec of sections) {
      const pool = pools[sec.category] || [];
      const take = Math.max(1, Number(sec.defaultCount || 2));
      sec.candidates = pool.slice(0, take).map((c) => ({ ...c }));
      sec.imageGenMeta = {
        route: 'pool-library',
        providerRequested: 'library',
        modelRequested: 'static-pool',
        providerUsed: 'library',
        modelUsed: 'static-pool',
        promptUsed: '',
        sectionPrompt: String(sec.prompt || '').trim(),
        sectionStyleKey: String(sec.styleKey || '').trim(),
        sectionTitle: String(sec.title || '').trim(),
      };
      sec.loading = false;
      const idx = sections.indexOf(sec);
      onProgress({
        phase: 'section',
        sectionIndex: idx,
        section: { ...sec },
        total: sections.length,
        completed: idx + 1,
      });
    }
  } else {
    for (let i = 0; i < sections.length; i += 1) {
      const sec = sections[i];
      onProgress({
        phase: 'section-start',
        sectionIndex: i,
        section: { ...sec },
        total: sections.length,
        completed: i,
      });
      const gen = await generateSectionCandidatesViaOpenClaw(sec, wf, i, {
        referenceExamples: (pools[sec.category] || []).slice(0, IMAGE_REFERENCE_MAX),
      });
      const persistedPaths = await persistGeneratedImagePaths(
        gen.paths,
        paths,
        opts?.assetGroupId || opts?.projectId || 'session',
        i,
      );
      const fromTool = persistedPaths.map((p, ix) => ({
        id: `c-${randomUUID()}`,
        name: path.basename(p) || `generated-${i + 1}-${ix + 1}.png`,
        path: p,
        url: toApiImageUrl(p),
      }));
      if (fromTool.length) {
        sec.candidates = fromTool;
      } else {
        const pool = pools[sec.category] || [];
        const fallback = pool.slice(0, Math.max(1, Number(sec.defaultCount || 2))).map((c) => ({ ...c }));
        sec.candidates = fallback;
        if (!sec.prompt) sec.prompt = stylePrompt(sec.styleKey, presets);
      }
      sec.imageGenMeta = gen.meta || {
        route: 'openclaw:image_generate',
        providerRequested: '(unknown)',
        modelRequested: '(unknown)',
        providerUsed: '(unknown)',
        modelUsed: '(unknown)',
        promptUsed: '',
        sectionPrompt: String(sec.prompt || '').trim(),
        sectionStyleKey: String(sec.styleKey || '').trim(),
        sectionTitle: String(sec.title || '').trim(),
      };
      sec.loading = false;
      if (!gen.ok && gen.error) sec.error = String(gen.error);
      onProgress({
        phase: 'section',
        sectionIndex: i,
        section: { ...sec },
        total: sections.length,
        completed: i + 1,
      });
    }
  }

  return {
    ok: true,
    ...base,
    suggestionSets: sections,
    engineUsed: 'openclaw',
  };
}

function normalizeSeedSections(rawSections, transcriptLines, presets, workflowConfig = null) {
  const src = Array.isArray(rawSections) ? rawSections : [];
  const maxIx = Math.max(0, transcriptLines.length - 1);
  const out = [];

  for (let i = 0; i < src.length; i += 1) {
    const row = src[i] || {};
    let start = NaN;
    let end = NaN;

    if (Array.isArray(row.lineRange) && row.lineRange.length >= 2) {
      start = Number(row.lineRange[0]);
      end = Number(row.lineRange[1]);
    }
    if (!Number.isFinite(start)) start = Number(row.lineStart);
    if (!Number.isFinite(end)) end = Number(row.lineEnd);
    if (!Number.isFinite(start) && row.startTc) start = nearestLineIndexByTc(transcriptLines, row.startTc);
    if (!Number.isFinite(end) && row.endTc) end = nearestLineIndexByTc(transcriptLines, row.endTc);

    const range = clampRange(start, end, maxIx);
    const styleKey = pickFirstStyleKey(String(row.styleKey || '').trim(), presets);
    const category = styleCategory(styleKey, presets);
    const snippetLines = transcriptLines.slice(range[0], range[1] + 1);
    const durationSeconds = Number.isFinite(Number(row.durationSeconds))
      ? Number(row.durationSeconds)
      : estimateSectionDurationSeconds(snippetLines, workflowConfig?.recommendations || {});

    const normalized = enforceSectionStyleRules({
      id: String(row.id || `seed-${String(i + 1).padStart(2, '0')}`),
      title: String(row.title || `Section ${i + 1}`),
      styleKey,
      category,
      sideSuggested: String(row.sideSelected || row.sideSuggested || row.side || '').toLowerCase() === 'left' ? 'left' : 'right',
      sideSelected: String(row.sideSelected || row.sideSuggested || row.side || '').toLowerCase() === 'left' ? 'left' : 'right',
      prompt: String(row.prompt || stylePrompt(styleKey, presets)).trim() || stylePrompt(styleKey, presets),
      defaultCount: Math.max(1, Math.min(6, Number(row.defaultCount || styleDefaultCount(styleKey, presets) || 2))),
      durationSeconds: Math.max(0.5, durationSeconds),
      startTc: transcriptLines[range[0]]?.tc || row.startTc || '00:00:00',
      endTc: transcriptLines[range[1]]?.tc || row.endTc || transcriptLines[range[0]]?.tc || '00:00:00',
      lineRange: range,
      transcriptSnippet: String(row.transcriptSnippet || snippetLines.map((c) => `[${c.tc}] ${c.text}`).join('\n')),
      candidates: (Array.isArray(row.candidates) ? row.candidates : []).map((c, j) => ({
        id: String(c?.id || `c-${randomUUID()}-${j}`),
        name: String(c?.name || `candidate-${j + 1}`),
        path: String(c?.path || ''),
        url: String(c?.url || (c?.path ? toApiImageUrl(String(c.path)) : '')),
      })).filter((c) => c.path || c.url),
      selectedCandidateId: String(row.selectedCandidateId || '').trim() || null,
    }, presets);

    out.push(normalized);
  }
  return out;
}

async function buildImagesForSections(paths, transcriptLines = [], sectionsSeed = [], workflowConfig = null, opts = {}) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : () => {};
  const wf = normalizeWorkflowConfig(workflowConfig || {});
  const lines = (Array.isArray(transcriptLines) ? transcriptLines : []).map((l, i) => ({
    idx: Number.isFinite(Number(l?.idx)) ? Number(l.idx) : i,
    tc: String(l?.tc || secondsToTc(i * 4)),
    text: String(l?.text || ''),
  })).filter((l) => l.text.trim().length > 0);

  const presets = await getPromptPresets(paths);
  const [referencePool, philosopherPool, memePool, evidencePool] = await Promise.all([
    listCategoryImages(paths, 'reference', 300),
    listCategoryImages(paths, 'philosopher', 300),
    listCategoryImages(paths, 'meme', 300),
    listCategoryImages(paths, 'evidence', 300),
  ]);

  const pools = {
    reference: referencePool,
    philosopher: philosopherPool,
    meme: memePool,
    evidence: evidencePool,
  };

  const base = {
    transcript: { totalLines: lines.length, lines },
    promptPresets: presets,
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    poolItems: pools,
    engineUsed: 'sections-imagegen',
  };

  if (!lines.length) {
    onProgress({ phase: 'sections-ready', base, suggestionSets: [], total: 0, completed: 0 });
    return { ok: true, ...base, suggestionSets: [] };
  }

  const forceRegenerate = !!opts?.forceRegenerate;
  const sections = normalizeSeedSections(sectionsSeed, lines, presets, wf).map((s) => ({
    ...s,
    candidates: forceRegenerate ? [] : (s.candidates || []),
    selectedCandidateId: forceRegenerate ? null : (s.selectedCandidateId || null),
    loading: forceRegenerate ? true : !((s.candidates || []).length),
  }));
  onProgress({ phase: 'sections-ready', base, suggestionSets: sections, total: sections.length, completed: 0 });

  if (String(wf.images?.engine || 'pool').toLowerCase() !== 'openclaw') {
    for (let i = 0; i < sections.length; i += 1) {
      const sec = sections[i];
      const pool = pools[sec.category] || [];
      const take = Math.max(1, Number(sec.defaultCount || 2));
      sec.candidates = pool.slice(0, take).map((c) => ({ ...c }));
      sec.imageGenMeta = {
        route: 'pool-library',
        providerRequested: 'library',
        modelRequested: 'static-pool',
        providerUsed: 'library',
        modelUsed: 'static-pool',
        promptUsed: '',
        sectionPrompt: String(sec.prompt || '').trim(),
        sectionStyleKey: String(sec.styleKey || '').trim(),
        sectionTitle: String(sec.title || '').trim(),
      };
      sec.loading = false;
      onProgress({ phase: 'section', sectionIndex: i, section: { ...sec }, total: sections.length, completed: i + 1 });
    }
  } else {
    const sectionsLimit = Math.max(0, Number(opts?.sectionsLimit || 0));
    let generatedThisRun = 0;
    for (let i = 0; i < sections.length; i += 1) {
      const sec = sections[i];
      if ((sec.candidates || []).length) {
        sec.loading = false;
        sec.imageGenMeta = sec.imageGenMeta || {
          route: 'existing-candidates',
          providerRequested: 'existing',
          modelRequested: 'existing',
          providerUsed: 'existing',
          modelUsed: 'existing',
          promptUsed: '',
          sectionPrompt: String(sec.prompt || '').trim(),
          sectionStyleKey: String(sec.styleKey || '').trim(),
          sectionTitle: String(sec.title || '').trim(),
        };
        onProgress({ phase: 'section', sectionIndex: i, section: { ...sec }, total: sections.length, completed: i + 1 });
        continue;
      }
      if (sectionsLimit > 0 && generatedThisRun >= sectionsLimit) {
        sec.loading = false;
        sec.imageGenMeta = {
          route: 'skipped-by-limit',
          providerRequested: '(limit)',
          modelRequested: `sectionsLimit=${sectionsLimit}`,
          providerUsed: '(limit)',
          modelUsed: `sectionsLimit=${sectionsLimit}`,
          promptUsed: '',
          sectionPrompt: String(sec.prompt || '').trim(),
          sectionStyleKey: String(sec.styleKey || '').trim(),
          sectionTitle: String(sec.title || '').trim(),
          note: `Skipped this run — sectionsLimit ${sectionsLimit} reached. Re-run to continue.`,
        };
        onProgress({ phase: 'section', sectionIndex: i, section: { ...sec }, total: sections.length, completed: i + 1 });
        continue;
      }
      generatedThisRun += 1;
      onProgress({ phase: 'section-start', sectionIndex: i, section: { ...sec }, total: sections.length, completed: i });
      const gen = await generateSectionCandidatesViaOpenClaw(sec, wf, i, {
        referenceExamples: (pools[sec.category] || []).slice(0, IMAGE_REFERENCE_MAX),
      });
      const persistedPaths = await persistGeneratedImagePaths(
        gen.paths,
        paths,
        opts?.assetGroupId || opts?.projectId || 'session',
        i,
      );
      const fromTool = persistedPaths.map((p, ix) => ({
        id: `c-${randomUUID()}`,
        name: path.basename(p) || `generated-${i + 1}-${ix + 1}.png`,
        path: p,
        url: toApiImageUrl(p),
      }));
      if (fromTool.length) {
        sec.candidates = fromTool;
      } else {
        const pool = pools[sec.category] || [];
        sec.candidates = pool.slice(0, Math.max(1, Number(sec.defaultCount || 2))).map((c) => ({ ...c }));
      }
      sec.imageGenMeta = gen.meta || {
        route: 'openclaw:image_generate',
        providerRequested: '(unknown)',
        modelRequested: '(unknown)',
        providerUsed: '(unknown)',
        modelUsed: '(unknown)',
        promptUsed: '',
        sectionPrompt: String(sec.prompt || '').trim(),
        sectionStyleKey: String(sec.styleKey || '').trim(),
        sectionTitle: String(sec.title || '').trim(),
      };
      sec.loading = false;
      if (!gen.ok && gen.error) sec.error = String(gen.error);
      onProgress({ phase: 'section', sectionIndex: i, section: { ...sec }, total: sections.length, completed: i + 1 });
    }
  }

  return {
    ok: true,
    ...base,
    suggestionSets: sections,
  };
}

function pruneRecommendationJobs() {
  const arr = [...recommendationJobs.values()].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  for (const j of arr.slice(MAX_RECOMMENDATION_JOBS)) recommendationJobs.delete(j.id);
}

function findRunningImageGenerationJob() {
  const jobs = [...recommendationJobs.values()];
  return jobs.find((j) => {
    const status = String(j?.status || '').toLowerCase();
    if (status !== 'queued' && status !== 'running') return false;
    return j?.generatesImages === true;
  }) || null;
}

function getRecommendationJobPublic(job, includePayload = false) {
  const out = {
    ok: true,
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    progress: job.progress || { percent: 0, stage: 'queued' },
    engine: job.engine || 'heuristic',
    mode: job.mode || 'recommendations',
    stats: job.stats || null,
  };
  if (includePayload) out.payload = job.payload || null;
  return out;
}

async function startRecommendationJob(paths, transcriptLines, workflowConfig = null, opts = {}) {
  const wf = normalizeWorkflowConfig(workflowConfig || {});
  const mode = String(opts?.mode || 'recommendations').toLowerCase() === 'images-only'
    ? 'images-only'
    : 'recommendations';
  const generatesImages = mode === 'images-only'
    || (
      mode === 'recommendations'
      && String(wf.recommendations?.engine || 'heuristic').toLowerCase() === 'openclaw'
      && String(wf.images?.engine || 'pool').toLowerCase() === 'openclaw'
    );
  if (generatesImages) {
    const runningImageJob = findRunningImageGenerationJob();
    if (runningImageJob) {
      const busyErr = new Error(`Image generation already running (job ${runningImageJob.id}). Wait for it to finish before starting another.`);
      busyErr.code = 'IMAGE_JOB_BUSY';
      busyErr.jobId = runningImageJob.id;
      throw busyErr;
    }
  }
  const sectionsSeed = Array.isArray(opts?.sections) ? opts.sections : [];
  const customPrompt = String(opts?.customPrompt || '').trim();
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const assetGroupId = String(opts?.assetGroupId || opts?.projectId || id).trim() || id;
  const now = new Date();
  const job = {
    id,
    status: 'queued',
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
    startedAt: null,
    finishedAt: null,
    error: null,
    progress: { percent: 0, stage: 'queued' },
    payload: null,
    stats: null,
    engine: mode === 'images-only'
      ? String(wf.images?.engine || 'pool')
      : String(wf.recommendations?.engine || 'heuristic'),
    mode,
    generatesImages,
  };
  recommendationJobs.set(id, job);
  pruneRecommendationJobs();

  const applyProgressEvent = (evt = {}, pctBase = 56, pctSpan = 36, startLabel = 'building sections') => {
    if (evt.phase === 'sections-ready') {
      const base = evt.base || {};
      job.payload = {
        ok: true,
        transcript: base.transcript || { totalLines: 0, lines: [] },
        promptPresets: base.promptPresets || {},
        pools: base.pools || {},
        poolItems: base.poolItems || {},
        suggestionSets: Array.isArray(evt.suggestionSets) ? evt.suggestionSets : [],
        engineUsed: base.engineUsed || 'openclaw',
      };
      const total = Math.max(1, Number(evt.total || (job.payload.suggestionSets || []).length || 1));
      job.progress = { percent: pctBase, stage: `${startLabel} 0/${total}` };
      return;
    }

    if (evt.phase === 'section' || evt.phase === 'section-start') {
      if (!job.payload) return;
      const total = Math.max(1, Number(evt.total || (job.payload.suggestionSets || []).length || 1));
      const completed = Math.max(0, Math.min(total, Number(evt.completed || 0)));
      const idx = Number(evt.sectionIndex || 0);
      if (evt.section && Array.isArray(job.payload.suggestionSets) && idx >= 0 && idx < job.payload.suggestionSets.length) {
        job.payload.suggestionSets[idx] = evt.section;
      }
      const pct = pctBase + Math.round((completed / total) * pctSpan);
      const stage = evt.phase === 'section-start'
        ? `generating images ${Math.min(total, completed + 1)}/${total}`
        : `generating images ${completed}/${total}`;
      job.progress = { percent: Math.max(pctBase, Math.min(92, pct)), stage };
    }
  };

  (async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.progress = { percent: 10, stage: mode === 'images-only' ? 'loading sections' : 'loading pools' };
    try {
      let out;
      if (mode === 'images-only') {
        job.progress = { percent: 28, stage: 'preparing section image generation' };
        out = await buildImagesForSections(paths, transcriptLines, sectionsSeed, wf, {
          assetGroupId,
          sectionsLimit: Math.max(0, Number(opts?.sectionsLimit || 0)),
          forceRegenerate: !!opts?.forceRegenerate,
          onProgress: (evt = {}) => applyProgressEvent(evt, 46, 46, 'preparing sections'),
        });
      } else if (job.engine === 'openclaw') {
        job.progress = { percent: 28, stage: 'running OpenClaw recommendation model' };
        out = await buildRecommendationsOpenClaw(paths, transcriptLines, wf, {
          customPrompt,
          assetGroupId,
          onProgress: (evt = {}) => applyProgressEvent(evt, 56, 36, 'building sections'),
        });
      } else {
        job.progress = { percent: 45, stage: 'building heuristic recommendations' };
        out = await buildRecommendationsHeuristic(paths, transcriptLines, wf);
        job.payload = out;
        const total = Number((out?.suggestionSets || []).length || 0);
        job.progress = { percent: 88, stage: `prepared ${total} sections` };
      }

      job.progress = { percent: 92, stage: 'finalizing result' };
      job.payload = out;
      job.stats = {
        transcriptLines: Number(out?.transcript?.totalLines || 0),
        suggestionSets: Number((out?.suggestionSets || []).length),
        pools: out?.pools || {},
      };
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.progress = { percent: 100, stage: 'done' };
    } catch (err) {
      job.status = 'error';
      job.error = String(err?.message || err);
      job.finishedAt = new Date().toISOString();
      job.progress = { percent: 100, stage: 'error' };
    }
  })().catch(() => {});

  return job;
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

async function runGenerateWithOptions(paths, opts = {}) {
  const args = [SCRIPT_PATH, '--storage-root', paths.storageRoot];
  if (opts.rawVideo) args.push('--raw-video', String(opts.rawVideo));
  if (opts.overlayImage) args.push('--overlay-image', String(opts.overlayImage));
  if (opts.label) args.push('--label', String(opts.label));
  if (Number.isFinite(Number(opts.offsetSeconds))) args.push('--offset-seconds', String(opts.offsetSeconds));
  if (Number.isFinite(Number(opts.durationSeconds))) args.push('--duration-seconds', String(opts.durationSeconds));
  if (Number.isFinite(Number(opts.overlayZoom))) args.push('--overlay-zoom', String(opts.overlayZoom));
  if (Number.isFinite(Number(opts.overlayPan))) args.push('--overlay-pan', String(opts.overlayPan));
  if (Number.isFinite(Number(opts.overlayTilt))) args.push('--overlay-tilt', String(opts.overlayTilt));

  const { stdout, stderr } = await execFileAsync('python3', args, {
    timeout: 180000,
    maxBuffer: 8_000_000,
  });

  const text = String(stdout || '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text.split('\n').filter(Boolean).slice(-1)[0]);
  } catch {
    parsed = { raw: text };
  }

  return {
    ok: true,
    result: parsed,
    stderr: String(stderr || '').trim(),
  };
}

async function listRecent(paths) {
  const items = [];
  try {
    const names = await fs.readdir(paths.timelineOut, { withFileTypes: true });
    for (const ent of names) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const p = path.join(paths.timelineOut, ent.name);
      const st = await fs.stat(p);
      items.push({ name: ent.name, mtimeMs: st.mtimeMs });
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    // ignore
  }
  return items.slice(0, 30);
}

async function pruneOldTests(paths, keep = 20) {
  const recent = await listRecent(paths);
  const toDelete = recent.slice(Math.max(0, keep));
  for (const item of toDelete) {
    await fs.rm(path.join(paths.timelineOut, item.name), { recursive: true, force: true });
  }
  return { kept: recent.slice(0, keep).map((x) => x.name), deleted: toDelete.map((x) => x.name) };
}

async function listVideosInTimelines(paths) {
  const dir = paths.ingestRoot;
  const out = [];

  async function walk(current, depth = 0) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const p = path.join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(p, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      const st = await fs.stat(p);
      const rel = path.relative(dir, p);
      out.push({ name: ent.name, label: rel, path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  await walk(dir, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function projectDir(paths, projectId) {
  return path.join(paths.projectsRoot, projectId);
}

async function listProjects(paths) {
  const idx = await readJsonIfExists(paths.projectIndexPath, { projects: [] });
  const projects = Array.isArray(idx.projects) ? idx.projects : [];
  return projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function saveProject(paths, payload = {}) {
  const name = String(payload.name || 'Untitled Project').trim();
  const base = slugify(name) || 'project';
  const id = String(payload.id || `${base}-${Date.now()}`);
  const dir = projectDir(paths, id);
  await fs.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const transcriptLines = Array.isArray(payload.transcriptLines) ? payload.transcriptLines : [];
  const transcriptText = String(
    payload.transcriptText
    || transcriptLines.map((l) => `[${l.tc || '00:00:00'}] ${l.text || ''}`).join('\n')
    || ''
  );

  if (transcriptText.trim()) {
    await fs.writeFile(path.join(dir, 'transcript.md'), transcriptText, 'utf-8');
  }

  const projectDoc = {
    schemaVersion: 1,
    id,
    name,
    createdAt: payload.createdAt || now,
    updatedAt: now,
    source: payload.source || {},
    transcriptLines,
    sets: Array.isArray(payload.sets) ? payload.sets : [],
    notes: payload.notes || '',
  };

  await writeJsonAtomic(path.join(dir, 'project.json'), projectDoc);

  const idx = await readJsonIfExists(paths.projectIndexPath, { projects: [] });
  const projects = Array.isArray(idx.projects) ? idx.projects : [];
  const meta = {
    id,
    name,
    updatedAt: now,
    createdAt: projectDoc.createdAt,
    path: dir,
    transcriptPath: path.join(dir, 'transcript.md'),
    rawVideoPath: String(projectDoc.source?.rawVideoPath || ''),
  };

  const next = [meta, ...projects.filter((p) => p.id !== id)].slice(0, 1000);
  await writeJsonAtomic(paths.projectIndexPath, { projects: next });

  return { ok: true, project: projectDoc, meta };
}

async function loadProject(paths, projectId) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('Missing project id');
  const docPath = path.join(projectDir(paths, id), 'project.json');
  const doc = await readJsonIfExists(docPath, null);
  if (!doc) throw new Error('Project not found');
  return doc;
}

async function deleteProject(paths, projectId) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('Missing project id');

  const dir = projectDir(paths, id);
  const exists = fsSync.existsSync(dir);
  if (!exists) throw new Error('Project not found');

  await fs.rm(dir, { recursive: true, force: true });

  const idx = await readJsonIfExists(paths.projectIndexPath, { projects: [] });
  const projects = Array.isArray(idx.projects) ? idx.projects : [];
  const next = projects.filter((p) => String(p.id || '') !== id);
  await writeJsonAtomic(paths.projectIndexPath, { projects: next });

  return { ok: true, deletedId: id };
}

async function resetProjects(paths) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(paths.projectsRoot, '_archive', ts);
  await fs.mkdir(archiveDir, { recursive: true });

  let moved = [];
  try {
    const entries = await fs.readdir(paths.projectsRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === '_archive') continue;
      const from = path.join(paths.projectsRoot, ent.name);
      const to = path.join(archiveDir, ent.name);
      await fs.rename(from, to).catch(async () => {
        await fs.rm(to, { recursive: true, force: true });
        await fs.rename(from, to);
      });
      moved.push(ent.name);
    }
  } catch {
    // ignore directory listing errors
  }

  await writeJsonAtomic(paths.projectIndexPath, { projects: [] });
  return { ok: true, archivedTo: archiveDir, movedCount: moved.length, moved };
}

function decodeBase64MaybeDataUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^data:.*?;base64,(.+)$/);
  const b64 = m ? m[1] : s;
  return Buffer.from(b64, 'base64');
}

async function handleUploadVideo(paths, payload = {}) {
  const fileName = String(payload.fileName || '').trim();
  const ext = path.extname(fileName).toLowerCase();
  if (!fileName || !VIDEO_EXTS.has(ext)) {
    throw new Error('Invalid file name or unsupported extension');
  }

  const bytes = decodeBase64MaybeDataUrl(payload.contentBase64);
  if (!bytes || !bytes.length) throw new Error('Missing upload bytes');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large for web upload option (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB)`);
  }

  const projectId = slugify(payload.projectId || '') || `upload-${Date.now()}`;
  const uploadsDir = path.join(paths.ingestRoot, projectId);
  await fs.mkdir(uploadsDir, { recursive: true });

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const outPath = path.join(uploadsDir, `${Date.now()}-${safeName}`);
  await fs.writeFile(outPath, bytes);

  const st = await fs.stat(outPath);
  return {
    ok: true,
    file: {
      name: path.basename(outPath),
      path: outPath,
      size: st.size,
      uploadedAt: new Date().toISOString(),
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = decodeURIComponent(url.pathname);

    const { cfg, p: paths } = await currentRuntime();

    if (pathname === `${BASE}/api/health`) {
      return sendJson(res, 200, { ok: true, app: 'podpics' });
    }

    if (pathname === `${BASE}/api/config`) {
      return sendJson(res, 200, {
        ok: true,
        workspaceRoot: AGENT_WORKSPACE_ROOT,
        storageRoot: paths.storageRoot,
        ingestRoot: paths.ingestRoot,
        projectsRoot: paths.projectsRoot,
        availableRoots: rootsFromConfig(cfg),
        maxUploadMb: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)),
        workflow: publicWorkflowConfig(cfg.workflow || defaultWorkflowConfig()),
      });
    }

    if (pathname === `${BASE}/api/workflow-config`) {
      if (method === 'GET') {
        const includeSecrets = url.searchParams.get('includeSecrets') === '1';
        return sendJson(res, 200, {
          ok: true,
          workflow: publicWorkflowConfig(cfg.workflow || defaultWorkflowConfig(), includeSecrets),
          defaults: publicWorkflowConfig(defaultWorkflowConfig(), false),
          choices: {
            transcriptionProviders: transcriptProviderChoices(),
            recommendationsEngine: ['heuristic', 'openclaw'],
            imagesEngine: ['pool', 'openclaw'],
            sessionMode: ['ephemeral', 'main'],
          },
        });
      }

      if (method === 'POST') {
        const payload = await readJsonBody(req);
        try {
          const wf = await setWorkflowConfig(payload.workflow || payload || {});
          return sendJson(res, 200, {
            ok: true,
            workflow: publicWorkflowConfig(wf, true),
          });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
        }
      }

      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    if (pathname === `${BASE}/api/gateway-models`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      try {
        const out = await gatewayCallJson('models.list', { view: 'all' }, 120000);
        const models = Array.isArray(out?.models) ? out.models : [];
        const normalized = models.map((m) => {
          if (typeof m === 'string') return { id: m, provider: '' };
          return {
            id: String(m?.id || m?.model || m?.value || '').trim(),
            provider: String(m?.provider || '').trim(),
            label: String(m?.label || '').trim(),
          };
        }).filter((m) => m.id);
        return sendJson(res, 200, { ok: true, models: normalized });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: String(err?.message || err), models: [] });
      }
    }

    if (pathname === `${BASE}/api/transcript-history`) {
      if (method === 'GET') {
        try {
          const history = await getTranscriptHistory(paths.storageRoot);
          return sendJson(res, 200, { ok: true, history });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String(err?.message || err), history: [] });
        }
      }

      if (method === 'POST') {
        const payload = await readJsonBody(req);
        try {
          const history = await saveTranscriptHistory(paths.storageRoot, payload?.history || []);
          return sendJson(res, 200, { ok: true, history });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
        }
      }

      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    if (pathname === `${BASE}/api/storage-root`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const payload = await readJsonBody(req);
      try {
        const nextCfg = await setStorageRoot(payload.path || '');
        const next = derivePaths(nextCfg.storageRoot);
        return sendJson(res, 200, {
          ok: true,
          storageRoot: next.storageRoot,
          projectsRoot: next.projectsRoot,
          availableRoots: rootsFromConfig(nextCfg),
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === `${BASE}/api/status`) {
      const recent = await listRecent(paths);
      return sendJson(res, 200, { ok: true, recent });
    }

    if (pathname === `${BASE}/api/videos`) {
      const videos = await listVideosInTimelines(paths);
      return sendJson(res, 200, { ok: true, videos });
    }

    if (pathname === `${BASE}/api/upload-video`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const payload = await readJsonBody(req);
      try {
        const out = await handleUploadVideo(paths, payload || {});
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === `${BASE}/api/transcript/generate`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const payload = await readJsonBody(req);
      try {
        const videoPath = normalizeAbs(payload.videoPath || payload.rawVideoPath || '');
        const transcriptCfg = normalizeTranscriptConfig({
          ...(cfg.workflow?.transcript || {}),
          ...((payload && typeof payload.transcriptConfig === 'object') ? payload.transcriptConfig : {}),
        });
        const job = await startTranscriptJob(paths, videoPath, transcriptCfg);
        return sendJson(res, 200, { ok: true, jobId: job.id, job: getTranscriptJobPublic(job, false) });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === `${BASE}/api/transcript/job`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return sendJson(res, 400, { ok: false, error: 'Missing id' });
      const job = transcriptJobs.get(id);
      if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
      const includeLines = url.searchParams.get('includeLines') === '1';
      return sendJson(res, 200, getTranscriptJobPublic(job, includeLines));
    }

    if (pathname === `${BASE}/api/bootstrap` || pathname === `${BASE}/api/mock-data`) {
      const data = await buildBootstrapData(paths);
      return sendJson(res, 200, data);
    }

    if (pathname === `${BASE}/api/recommendations`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const payload = await readJsonBody(req);
      try {
        const wf = normalizeWorkflowConfig({
          ...(cfg.workflow || {}),
          ...((payload && typeof payload.workflow === 'object') ? payload.workflow : {}),
        }, cfg.workflow || defaultWorkflowConfig());
        const out = wf.recommendations?.engine === 'openclaw'
          ? await buildRecommendationsOpenClaw(paths, payload.transcriptLines || [], wf, {
            customPrompt: String(payload?.customPrompt || '').trim(),
          })
          : await buildRecommendationsHeuristic(paths, payload.transcriptLines || [], wf);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === `${BASE}/api/recommendations/generate`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const payload = await readJsonBody(req);
      try {
        const wf = normalizeWorkflowConfig({
          ...(cfg.workflow || {}),
          ...((payload && typeof payload.workflow === 'object') ? payload.workflow : {}),
        }, cfg.workflow || defaultWorkflowConfig());
        const mode = String(payload?.mode || 'recommendations').toLowerCase() === 'images-only'
          ? 'images-only'
          : 'recommendations';
        const job = await startRecommendationJob(paths, payload.transcriptLines || [], wf, {
          mode,
          sections: Array.isArray(payload?.sections) ? payload.sections : [],
          customPrompt: String(payload?.customPrompt || '').trim(),
          projectId: String(payload?.projectId || '').trim(),
          sectionsLimit: Math.max(0, Number(payload?.sectionsLimit || 0)),
          forceRegenerate: !!payload?.forceRegenerate,
        });
        return sendJson(res, 200, { ok: true, jobId: job.id, job: getRecommendationJobPublic(job, false) });
      } catch (err) {
        if (String(err?.code || '') === 'IMAGE_JOB_BUSY') {
          return sendJson(res, 409, { ok: false, error: String(err?.message || err), jobId: String(err?.jobId || '') || null });
        }
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === `${BASE}/api/recommendations/job`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return sendJson(res, 400, { ok: false, error: 'Missing id' });
      const includePayload = url.searchParams.get('includePayload') === '1';
      const job = recommendationJobs.get(id);
      if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
      return sendJson(res, 200, getRecommendationJobPublic(job, includePayload));
    }

    if (pathname === `${BASE}/api/prompt-presets`) {
      if (method === 'GET') {
        const presets = await getPromptPresets(paths);
        return sendJson(res, 200, { ok: true, presets });
      }
      if (method === 'POST') {
        const payload = await readJsonBody(req);
        const presets = await setPromptPresets(paths, payload.presets || {});
        return sendJson(res, 200, { ok: true, presets });
      }
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    if (pathname === `${BASE}/api/projects`) {
      const projects = await listProjects(paths);
      return sendJson(res, 200, { ok: true, projects });
    }

    if (pathname === `${BASE}/api/projects/reset`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const out = await resetProjects(paths);
      return sendJson(res, 200, out);
    }

    if (pathname === `${BASE}/api/project`) {
      if (method === 'GET') {
        try {
          const project = await loadProject(paths, url.searchParams.get('id') || '');
          return sendJson(res, 200, { ok: true, project });
        } catch (err) {
          return sendJson(res, 404, { ok: false, error: String(err?.message || err) });
        }
      }

      if (method === 'POST') {
        const payload = await readJsonBody(req);
        try {
          const out = await saveProject(paths, payload || {});
          return sendJson(res, 200, out);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
        }
      }

      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    if (pathname === `${BASE}/api/project/delete`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      const payload = await readJsonBody(req);
      try {
        const out = await deleteProject(paths, payload.id || payload.projectId || '');
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === `${BASE}/api/video`) {
      const requested = normalizeAbs(url.searchParams.get('path') || '');
      if (!requested) {
        return send(res, 400, 'Missing path', { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      if (
        !inAllowedDir(requested, paths.ingestRoot)
        && !inAllowedDir(requested, paths.timelineOut)
        && !inAllowedDir(requested, paths.projectsRoot)
      ) {
        return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      try {
        return await streamFileWithRange(req, res, requested, videoMimeFromName(requested));
      } catch {
        return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    }

    if (pathname === `${BASE}/api/image`) {
      const requested = url.searchParams.get('path') || '';
      if (!requested) {
        return send(res, 400, 'Missing path', { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      if (
        !inAllowedDir(requested, paths.imageLibraryRoot)
        && !inAllowedDir(requested, paths.ingestRoot)
        && !inAllowedDir(requested, paths.timelineOut)
        && !inAllowedDir(requested, paths.projectsRoot)
        && !inAllowedDir(requested, OPENCLAW_MEDIA_ROOT)
      ) {
        return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      try {
        const bytes = await fs.readFile(requested);
        return send(res, 200, bytes, { 'Content-Type': imageMimeFromName(requested) });
      } catch {
        return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    }

    if (pathname === `${BASE}/api/generate-test`) {
      if (method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      }
      try {
        const payload = await readJsonBody(req);
        const out = await runGenerateWithOptions(paths, payload || {});
        const prune = await pruneOldTests(paths, 20);
        return sendJson(res, 200, { ...out, prune });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }

    if (pathname === BASE || pathname === `${BASE}/`) {
      const html = await fs.readFile(INDEX_PATH);
      return send(res, 200, html, { 'Content-Type': MIME['.html'] });
    }

    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (err) {
    return send(res, 500, String(err?.message || err), { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[podpics] listening on http://${HOST}:${PORT}${BASE}`);
});
