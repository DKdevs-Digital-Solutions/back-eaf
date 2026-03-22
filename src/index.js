require("dotenv").config();

const express = require("express");
const mime = require("mime-types");
const multer = require("multer");
const swaggerUi = require("swagger-ui-express");

const { makeR2Client, putObject, listByPrefix, publicUrlForKey, headObject } = require("./r2");
const { sendToCrmUploadFromUrl, sendToCrmUpdateFromUrl } = require("./crm");
const { sanitizeProtocol, guessFilenameFromUrl, downloadAsBuffer, makeObjectKey, normalizeTypeExt } = require("./utils");
const { saveAttachmentMap, getAttachmentMap } = require("./redis");
const { buildSwaggerSpec } = require("./swagger");

const app = express();
app.use(express.json({ limit: "1mb" }));

const MAX_MB_UPLOAD = Number(process.env.MAX_DOWNLOAD_MB || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB_UPLOAD * 1024 * 1024 }
});

// Swagger
const swaggerSpec = buildSwaggerSpec();
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const r2 = makeR2Client();
const BUCKET = process.env.R2_BUCKET;
const MAX_MB = MAX_MB_UPLOAD;

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /upload-from-url
 * body: { fileUrl, protocol, ticketId, name?, type? (jpg|png|pdf...) }
 *
 * Fluxo:
 * - baixa fileUrl
 * - salva no R2 em protocol/...
 * - envia a URL pública ao CRM (upload-from-url)
 * - salva no Redis o mapeamento (ticketId + r2Key -> attachmentId)
 */
app.post("/upload-from-url", async (req, res) => {
  try {
    const { fileUrl, protocol, ticketId, name, type } = req.body || {};
    if (!fileUrl || !protocol || !ticketId) {
      return res.status(400).json({ error: "fileUrl, protocol, ticketId são obrigatórios" });
    }

    const p = sanitizeProtocol(protocol);

    const { buffer, contentType, contentLength } = await downloadAsBuffer(fileUrl, MAX_MB);

    const original = guessFilenameFromUrl(fileUrl);
    const key = makeObjectKey({ protocol: p, originalName: original, contentType });

    await putObject({ client: r2, bucket: BUCKET, key, body: buffer, contentType, contentLength });

    const publicUrl = publicUrlForKey(key);

    // type do CRM é extensão (jpg/png/pdf...)
    const inferredExt = normalizeTypeExt(
      type ||
      (original && original.includes(".") ? original.split(".").pop() : null) ||
      mime.extension(contentType) ||
      "bin"
    );

    const finalName = name || original || key.split("/").pop();

    const crmResp = await sendToCrmUploadFromUrl({
      ticketId,
      name: finalName,
      protocol: p,
      type: inferredExt,
      url: publicUrl
    });

    const attachmentId = crmResp?.data?._id;
    if (!attachmentId) {
      return res.status(502).json({
        error: "CRM não retornou _id (attachmentId).",
        crm: { status: crmResp.status, data: crmResp.data }
      });
    }

    await saveAttachmentMap({
      ticketId,
      r2Key: key,
      attachmentId,
      publicUrl,
      protocol: p,
      name: finalName,
      type: inferredExt
    });

    return res.json({
      r2: { bucket: BUCKET, key, publicUrl },
      crm: { status: crmResp.status, data: crmResp.data, attachmentId }
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      error: err.message,
      details: err?.response?.data
    });
  }
});

/**
 * GET /files?protocol=xxx&ticketId=yyy(optional)
 * lista objetos no prefixo protocol/
 * se ticketId for informado, tenta enriquecer com attachmentId via Redis
 */
app.get("/files", async (req, res) => {
  try {
    const protocol = sanitizeProtocol(req.query.protocol);
    const ticketId = req.query.ticketId;

    const prefix = `${protocol}/`;
    const items = await listByPrefix({ client: r2, bucket: BUCKET, prefix });

    const enriched = await Promise.all(items.map(async (it) => {
      const publicUrl = it.key ? publicUrlForKey(it.key) : null;
      const fileName = it.key ? it.key.split("/").pop() : null;

      let attachmentId = null;
      let nameFromMap = null;

      if (ticketId && it.key) {
        const map = await getAttachmentMap(ticketId, it.key);
        attachmentId = map?.attachmentId || null;
        nameFromMap = map?.name || null;
      }

      return {
        ...it,
        publicUrl,
        attachmentId,
        fileName,
        // "name" é o nome amigável (se você salvou no upload), senão cai no nome do arquivo
        name: nameFromMap || fileName
      };
    }));

    return res.json({ prefix, items: enriched });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /replace
 * Content-Type: multipart/form-data
 * campos: file (obrigatório), protocol (obrigatório), key?, ticketId?, attachmentId?, name?, type?
 *
 * - Recebe o arquivo via multipart (campo "file")
 * - Se key for informado: sobrescreve aquele objeto no R2
 * - Se NÃO: gera novo key no protocol/
 * - Se ticketId estiver presente:
 *    - se attachmentId não vier, tenta resolver via Redis usando (ticketId + key)
 *    - se resolver, chama PUT no CRM (update)
 */
app.put("/replace", upload.single("file"), async (req, res) => {
  try {
    const { protocol, key: keyFromBody, ticketId, attachmentId, name, type } = req.body || {};

    if (!protocol) return res.status(400).json({ error: "protocol é obrigatório" });
    if (!req.file) return res.status(400).json({ error: "campo 'file' é obrigatório (multipart/form-data)" });

    const p = sanitizeProtocol(protocol);

    const buffer = req.file.buffer;
    const contentType = req.file.mimetype || "application/octet-stream";
    const contentLength = buffer.length;
    const originalName = req.file.originalname || null;

    if (contentLength > MAX_MB * 1024 * 1024) {
      return res.status(400).json({ error: `Arquivo maior que ${MAX_MB}MB` });
    }

    let key = keyFromBody;
    if (key) {
      if (!key.startsWith(`${p}/`)) return res.status(400).json({ error: "key precisa começar com protocol/" });
      await headObject({ client: r2, bucket: BUCKET, key }).catch(() => null);
    } else {
      key = makeObjectKey({ protocol: p, originalName, contentType });
    }

    await putObject({ client: r2, bucket: BUCKET, key, body: buffer, contentType, contentLength });
    const publicUrl = publicUrlForKey(key);

    const inferredExt = normalizeTypeExt(
      type ||
      (originalName && originalName.includes(".") ? originalName.split(".").pop() : null) ||
      (key.includes(".") ? key.split(".").pop() : null) ||
      mime.extension(contentType) ||
      "bin"
    );

    const finalName = name || originalName || key.split("/").pop();

    // CRM update opcional
    let crm = null;
    if (ticketId) {
      let finalAttachmentId = attachmentId || null;

      if (!finalAttachmentId) {
        const map = await getAttachmentMap(ticketId, key);
        finalAttachmentId = map?.attachmentId || null;
      }

      if (!finalAttachmentId) {
        return res.status(400).json({
          error: "ticketId informado, mas attachmentId não foi enviado e não foi encontrado no Redis para esse ticketId+key.",
          hint: "Garanta que o arquivo foi criado via /upload-from-url (para salvar o map) ou envie attachmentId explicitamente."
        });
      }

      const crmResp = await sendToCrmUpdateFromUrl({
        ticketId,
        attachmentId: finalAttachmentId,
        name: finalName,
        protocol: p,
        type: inferredExt,
        url: publicUrl
      });

      crm = { status: crmResp.status, data: crmResp.data, attachmentId: finalAttachmentId };

      await saveAttachmentMap({
        ticketId,
        r2Key: key,
        attachmentId: finalAttachmentId,
        publicUrl,
        protocol: p,
        name: finalName,
        type: inferredExt
      });
    }

    return res.json({
      r2: { bucket: BUCKET, key, publicUrl },
      crm
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      error: err.message,
      details: err?.response?.data
    });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API on :${port} (docs: /docs)`));
