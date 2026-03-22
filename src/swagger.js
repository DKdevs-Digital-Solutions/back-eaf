const swaggerJSDoc = require("swagger-jsdoc");

function buildSwaggerSpec() {
  return swaggerJSDoc({
    definition: {
      openapi: "3.0.3",
      info: {
        title: "R2 + CRM Backend",
        version: "1.0.0"
      },
      servers: [
        { url: "http://localhost:" + (process.env.PORT || 3000) }
      ],
      components: {
        schemas: {
          UploadFromUrlRequest: {
            type: "object",
            required: ["fileUrl", "protocol", "ticketId"],
            properties: {
              fileUrl: { type: "string", example: "https://site.com/rg-frente.jpg" },
              protocol: { type: "string", example: "20265456400" },
              ticketId: { type: "string", example: "ad2a2afa7-7ab5-451c-9b56-8692a8fa9c33" },
              name: { type: "string", example: "RG_Frente" },
              type: { type: "string", example: "jpg", description: "Extensão: jpg|png|pdf..." }
            }
          },
          ReplaceRequest: {
            type: "object",
            required: ["file", "protocol"],
            properties: {
              file: { type: "string", format: "binary", description: "Arquivo a ser enviado (multipart/form-data)" },
              protocol: { type: "string", example: "20265456400" },
              key: { type: "string", example: "20265456400/rg-frente.jpg", description: "Se quiser sobrescrever o mesmo arquivo no R2" },
              ticketId: { type: "string", example: "ad2a2afa7-7ab5-451c-9b56-8692a8fa9c33", description: "Se informado, tentará atualizar também no CRM" },
              attachmentId: { type: "string", example: "65f0c...", description: "Opcional: se omitido, tenta resolver via Redis usando ticketId+key" },
              name: { type: "string", example: "RG_Frente" },
              type: { type: "string", example: "jpg" }
            }
          },
          FilesResponseItem: {
            type: "object",
            properties: {
              key: { type: "string" },
              size: { type: "number" },
              lastModified: { type: "string", format: "date-time" },
              publicUrl: { type: "string" },
              fileName: { type: ["string","null"], description: "Nome do arquivo (basename do key)" },
              name: { type: ["string","null"], description: "Nome amigável para exibir na UI (do Redis) ou fileName" },
              attachmentId: { type: ["string", "null"], description: "Só aparece se ticketId for informado e existir mapeamento no Redis" }
            }
          }
        }
      },
      paths: {
        "/health": {
          get: {
            summary: "Healthcheck",
            responses: { 200: { description: "OK" } }
          }
        },
        "/upload-from-url": {
          post: {
            summary: "Baixa um arquivo por URL, salva no R2, cadastra no CRM e salva attachmentId no Redis",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { "$ref": "#/components/schemas/UploadFromUrlRequest" }
                }
              }
            },
            responses: {
              200: { description: "OK" },
              400: { description: "Erro de validação" },
              502: { description: "Falha ao interpretar resposta do CRM" }
            }
          }
        },
        "/files": {
          get: {
            summary: "Lista arquivos no R2 por protocol (prefixo). Opcionalmente enriquece com attachmentId via Redis",
            parameters: [
              { name: "protocol", in: "query", required: true, schema: { type: "string" } },
              { name: "ticketId", in: "query", required: false, schema: { type: "string" } }
            ],
            responses: {
              200: {
                description: "Lista",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        prefix: { type: "string" },
                        items: {
                          type: "array",
                          items: { "$ref": "#/components/schemas/FilesResponseItem" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "/replace": {
          put: {
            summary: "Recebe arquivo via multipart/form-data, substitui/insere no R2 e (se ticketId existir) atualiza no CRM",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: { "$ref": "#/components/schemas/ReplaceRequest" }
                }
              }
            },
            responses: {
              200: { description: "OK" },
              400: { description: "Erro de validação/mapeamento" }
            }
          }
        }
      }
    },
    apis: []
  });
}

module.exports = { buildSwaggerSpec };
