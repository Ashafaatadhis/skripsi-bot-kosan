// Short-term memory
export const RAW_TAIL_COUNT = 6;
export const MESSAGE_TOKEN_LIMIT = 800;
export const SUMMARY_TOKEN_LIMIT = 400;

// Long-term checkpoint trigger
export const CHECKPOINT_TOKEN_THRESHOLD = 2000;

// Fact promotion
export const FACT_MIN_SEEN = 2;
export const FACT_MAX_CHECKPOINTS = 4;

// Episode promotion
export const EPISODE_MIN_SEEN = 2;
export const EPISODE_MAX_CHECKPOINTS = 5;
export const EPISODE_MIN_IMPORTANCE = 0.6;

// Pending candidates
export const MAX_PENDING_CANDIDATES = 15;
export const MAX_AGE_DAYS = 14;

// Episode TTL
export const EPISODE_TTL_DAYS = 30;

// Fact categories for kosan context
export const FACT_CATEGORIES = [
  "profile",         // nama, nomor HP, pekerjaan
  "preference",      // budget ideal, lokasi, fasilitas
  "constraint",      // batasan: budget max, lantai, dll
  "rental_context",  // kamar yang disewa, periode aktif
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];
