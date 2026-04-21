/**
 * config.ts — Configuration (Bun auto-loads .env)
 */

export const config = {
  telegramToken:  process.env.TELEGRAM_BOT_TOKEN   ?? "",
  groqKey:        process.env.GROQ_API_KEY          ?? "",
  allowedChatIds: process.env.TELEGRAM_ALLOWED_IDS  ?? "",
  adminChatIds:   process.env.TELEGRAM_ADMIN_IDS   ?? process.env.TELEGRAM_ALLOWED_IDS ?? "",
  ownerChatId:    process.env.TELEGRAM_OWNER_CHAT_ID ?? "",
};
