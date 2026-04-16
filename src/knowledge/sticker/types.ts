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
  | 'smug' | 'annoyed' | 'dramatic' | 'cozy' | 'love'
  | 'shocked' | 'proud' | 'laughing' | 'pensive' | 'excited'
  | 'sarcastic' | 'nervous' | 'relieved' | 'determined' | 'mischievous'
  | 'bored' | 'disappointed' | 'grateful' | 'surprised' | 'embarrassed'
  | 'thinking' | 'celebrating' | 'crying_happy' | 'rage' | 'blank';

export const ALLOWED_INTENTS: readonly StickerIntent[] = [
  'cute', 'comfort', 'tease', 'happy', 'sleepy',
  'curious', 'playful', 'confused', 'shy', 'sad',
  'smug', 'annoyed', 'dramatic', 'cozy', 'love',
  'shocked', 'proud', 'laughing', 'pensive', 'excited',
  'sarcastic', 'nervous', 'relieved', 'determined', 'mischievous',
  'bored', 'disappointed', 'grateful', 'surprised', 'embarrassed',
  'thinking', 'celebrating', 'crying_happy', 'rage', 'blank',
] as const;

export const INTENT_SYNONYMS: Record<StickerIntent, readonly string[]> = {
  cute:         ['cute', 'adorable', 'innocent', 'gentle', 'soft', 'sweet'],
  comfort:      ['comfort', 'cozy', 'gentle', 'warm', 'calm', 'reassuring', 'affectionate'],
  tease:        ['tease', 'teasing', 'smug', 'mischievous', 'sassy', 'cheeky'],
  happy:        ['happy', 'playful', 'goofy', 'silly', 'cheerful', 'excited', 'joyful'],
  sleepy:       ['sleepy', 'tired', 'low-energy', 'drowsy', 'yawning', 'lazy', 'dazed'],
  curious:      ['curious', 'watchful', 'sneaky', 'peeking', 'interested'],
  playful:      ['playful', 'goofy', 'silly', 'fun', 'bouncy', 'energetic'],
  confused:     ['confused', 'dazed', 'blank', 'puzzled', 'lost', 'deadpan'],
  shy:          ['shy', 'flustered', 'blushing', 'awkward', 'bashful'],
  sad:          ['sad', 'pouty', 'helpless', 'lonely', 'melancholy', 'crying'],
  smug:         ['smug', 'confident', 'superior', 'unimpressed'],
  annoyed:      ['annoyed', 'irritated', 'grumpy', 'unimpressed', 'deadpan', 'dramatic'],
  dramatic:     ['dramatic', 'exaggerated', 'panicked', 'screaming'],
  cozy:         ['cozy', 'warm', 'snuggly', 'comfortable', 'relaxed'],
  love:         ['love', 'affectionate', 'heart', 'romantic', 'adoring', 'gentle'],
  shocked:      ['shocked', 'stunned', 'disbelief', 'jaw-drop', 'astonished', 'speechless'],
  proud:        ['proud', 'accomplished', 'satisfied', 'self-satisfied', 'confident'],
  laughing:     ['laughing', 'lol', 'hilarious', 'cracking-up', 'giggling', 'amused'],
  pensive:      ['pensive', 'reflective', 'wistful', 'contemplative', 'wistful', 'nostalgic'],
  excited:      ['excited', 'hyped', 'thrilled', 'pumped', 'eager', 'enthusiastic'],
  sarcastic:    ['sarcastic', 'ironic', 'eye-roll', 'deadpan', 'dry', 'dismissive'],
  nervous:      ['nervous', 'anxious', 'worried', 'uneasy', 'tense', 'jittery'],
  relieved:     ['relieved', 'phew', 'exhale', 'relaxed', 'safe', 'unburdened'],
  determined:   ['determined', 'resolute', 'focused', 'serious', 'firm', 'driven'],
  mischievous:  ['mischievous', 'sneaky', 'plotting', 'devious', 'scheming', 'cheeky'],
  bored:        ['bored', 'uninterested', 'indifferent', 'yawning', 'listless', 'meh'],
  disappointed: ['disappointed', 'let-down', 'dejected', 'disheartened', 'sad', 'sulking'],
  grateful:     ['grateful', 'thankful', 'appreciative', 'touched', 'moved'],
  surprised:    ['surprised', 'startled', 'unexpected', 'wide-eyed', 'taken-aback'],
  embarrassed:  ['embarrassed', 'flustered', 'blushing', 'ashamed', 'awkward', 'cringe'],
  thinking:     ['thinking', 'pondering', 'hmm', 'considering', 'deliberating', 'wondering'],
  celebrating:  ['celebrating', 'party', 'cheering', 'victory', 'woohoo', 'festive'],
  crying_happy: ['crying_happy', 'tears-of-joy', 'overwhelmed', 'moved', 'emotional', 'touched'],
  rage:         ['rage', 'furious', 'angry', 'enraged', 'livid', 'fuming'],
  blank:        ['blank', 'expressionless', 'empty', 'void', 'deadpan', 'numb'],
};
