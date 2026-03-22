# R2 + CRM Backend (Node.js + Docker + Swagger + Redis)

## O que faz
- Baixa um arquivo por URL
- Envia para Cloudflare R2 no diretório/prefixo `protocol/`
- Gera URL pública do R2
- Envia essa URL para o CRM via `upload-from-url`
- Armazena o `attachmentId` retornado pelo CRM no Redis (mapeamento `ticketId + r2Key -> attachmentId`)
- Lista arquivos por `protocol` (e opcionalmente retorna `attachmentId` se `ticketId` for informado)
- Substitui arquivo no R2 e atualiza o anexo no CRM (com auto-refresh de token)

## Rodar
1) Copie `.env.example` para `.env` e preencha as credenciais.
2) Suba:
```bash
docker compose up --build
```

## Swagger
- http://localhost:3000/docs

## Endpoints principais
- POST `/upload-from-url`
- GET `/files?protocol=...&ticketId=...` (ticketId é opcional)
- PUT `/replace`
- GET `/health`

> Dica: Para atualizar no CRM sem mandar `attachmentId`, use `ticketId + key` e deixe o backend resolver via Redis.
