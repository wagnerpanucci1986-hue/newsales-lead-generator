-- Busca por texto e por contato na caixa de entrada.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- DropIndex
DROP INDEX "Contact_name_idx";

-- CreateIndex
CREATE INDEX "Contact_name_trgm_idx" ON "Contact" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_pushName_trgm_idx" ON "Contact" USING GIN ("pushName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_phone_trgm_idx" ON "Contact" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Conversation_title_trgm_idx" ON "Conversation" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Message_text_trgm_idx" ON "Message" USING GIN ("text" gin_trgm_ops);
