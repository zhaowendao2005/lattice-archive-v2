-- 放弃 api_hash 加密：凭据以明文保存，密钥 TG_CRED_KEY 不再需要。
-- Telegram 会话（auth_key）始终只保存在本机，D1 中没有任何可登录凭证。
ALTER TABLE tg_apps RENAME COLUMN api_hash_enc TO api_hash;
