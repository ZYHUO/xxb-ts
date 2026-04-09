// ────────────────────────────────────────
// Sticker system types
// ────────────────────────────────────────

export type AnalysisStatus = 'pending' | 'ready' | 'failed' | 'waiting_for_preview';
export type AssetStatus = 'missing' | 'raw_ready' | 'preview_required' | 'preview_ready';
export type StickerFormat = 'static_webp' | 'animated_tgs' | 'video_webm' | 'unknown';

export interface StickerItem {
  fileUniqueId: string;
  latestFileId: string | null;
  setName: string | null;
  emoji: string | null;
  stickerFormat: StickerFormat;
  usageCount: number;
  sampleCount: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  analysisStatus: AnalysisStatus;
  analysisReason: string | null;
  analysisUpdatedAt: number | null;
  assetStatus: AssetStatus;
  rawAssetPath: string | null;
  previewAssetPath: string | null;
  emotionTags: string[] | null;
  moodMap: Record<string, number> | null;
  personaFit: boolean | null;
  description: string | null;
}

export interface StickerSample {
  id?: number;
  fileUniqueId: string;
  chatId: number;
  messageId: number;
  date: number;
  fromUserId: number | null;
  username: string | null;
  replyToMessageId: number | null;
  replyTargetText: string | null;
  contextBefore: string | null;
}

export interface StickerMeta {
  fileUniqueId: string;
  fileId: string | null;
  setName: string | null;
  emoji: string | null;
  stickerFormat: StickerFormat;
}

export type StickerIntent =
  | 'cute' | 'comfort' | 'tease' | 'happy' | 'sleepy'
  | 'curious' | 'playful' | 'confused' | 'shy' | 'sad'
  | 'smug' | 'annoyed' | 'dramatic' | 'cozy' | 'love';

export const ALLOWED_INTENTS: readonly StickerIntent[] = [
  'cute', 'comfort', 'tease', 'happy', 'sleepy',
  'curious', 'playful', 'confused', 'shy', 'sad',
  'smug', 'annoyed', 'dramatic', 'cozy', 'love',
] as const;

export const INTENT_SYNONYMS: Record<StickerIntent, readonly string[]> = {
  cute:     ['cute', 'adorable', 'innocent', 'gentle', 'soft', 'sweet'],
  comfort:  ['comfort', 'cozy', 'gentle', 'warm', 'calm', 'reassuring', 'affectionate'],
  tease:    ['tease', 'teasing', 'smug', 'mischievous', 'sassy', 'cheeky'],
  happy:    ['happy', 'playful', 'goofy', 'silly', 'cheerful', 'excited', 'joyful'],
  sleepy:   ['sleepy', 'tired', 'low-energy', 'drowsy', 'yawning', 'lazy', 'dazed'],
  curious:  ['curious', 'watchful', 'sneaky', 'peeking', 'interested'],
  playful:  ['playful', 'goofy', 'silly', 'fun', 'bouncy', 'energetic'],
  confused: ['confused', 'dazed', 'blank', 'puzzled', 'lost', 'deadpan'],
  shy:      ['shy', 'flustered', 'embarrassed', 'blushing', 'awkward', 'bashful'],
  sad:      ['sad', 'pouty', 'helpless', 'lonely', 'melancholy', 'crying'],
  smug:     ['smug', 'confident', 'proud', 'superior', 'unimpressed'],
  annoyed:  ['annoyed', 'irritated', 'grumpy', 'unimpressed', 'deadpan', 'dramatic'],
  dramatic: ['dramatic', 'exaggerated', 'shocked', 'panicked', 'screaming'],
  cozy:     ['cozy', 'warm', 'snuggly', 'comfortable', 'relaxed'],
  love:     ['love', 'affectionate', 'heart', 'romantic', 'adoring', 'gentle'],
};
