# DocSynth API

Backend NestJS com PostgreSQL, Prisma e MinIO para armazenar PDFs.

## Desenvolvimento local

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm start:dev
# em outro terminal
UV_CACHE_DIR=ocr_worker/.uv-cache uv sync --project ocr_worker
pnpm ocr:worker
```

Troque `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `S3_SECRET_KEY` e `JWT_SECRET` no `.env` local antes de iniciar. Mantenha `DATABASE_URL` alinhada às credenciais do PostgreSQL e `S3_ACCESS_KEY`/`S3_SECRET_KEY` às do MinIO. O arquivo `.env` contém segredos e não deve entrar no Git; apenas `.env.example` é versionado. `FRONTEND_ORIGIN` é a origem exata do frontend, e `PORT` define a porta da API. O cliente Prisma em `src/generated/prisma/` é gerado por `pnpm db:migrate`, `pnpm build` ou `pnpm start:dev`; não deve entrar no commit.

O Compose publica PostgreSQL, MinIO e Redis apenas em `127.0.0.1`, pois esta configuração é para desenvolvimento local.

PostgreSQL fica em `localhost:5432`; MinIO usa `localhost:9000` para a API S3 e `localhost:9001` para o console; Redis fica em `localhost:6379`. Ajuste portas e credenciais no `.env`; Compose, backend e worker leem esse arquivo. O worker instala o pacote local `../../OCR-Extraction` (relativo a `backend/`) e usa o servidor compatível com OpenAI definido por `OCR_BASE_URL` (padrão `http://localhost:8081/v1`). A síntese usa `SUMMARY_MODEL` e `/v1/chat/completions` com `stream=true`; os deltas passam pelo Redis Pub/Sub do worker à API e chegam ao SSE autenticado `GET /documents/:id/events`. Redis faz a ponte entre processos; PostgreSQL continua como fonte de verdade dos documentos e das sínteses salvas. Execute uma instância do backend e do worker; antes de escalar, substitua as listas simples por consumer groups do Redis.

Para `SUMMARY_MODEL` Ternary Bonsai, o worker solicita `enable_thinking=false` na síntese: o modelo começa a emitir o texto visível sem uma longa fase de raciocínio oculto. Outros modelos preservam seu template padrão; se emitirem `reasoning_content`, a interface mostra apenas o estado “Raciocinando…”. O worker também solicita `return_progress=true` ao llama.cpp; enquanto o prompt é processado, repassa `prompt_progress.processed / prompt_progress.total` pelo SSE como `{"kind":"prompt_progress","percent":22}`. A interface mostra a porcentagem até começar a geração do texto. Esse recurso requer uma versão do llama.cpp que aceite `return_progress` em `/v1/chat/completions`. Os logs do worker registram o tempo até o primeiro raciocínio, o primeiro trecho visível e a conclusão, sem registrar o conteúdo.

A documentação interativa da API fica em `http://localhost:3000/docs`.

O endpoint `POST /documents` recebe um multipart com o campo `file` (PDF até 20 MB). O arquivo é salvo no MinIO sob uma chave UUID e enfileirado no Redis. O worker converte-o para Markdown e salva `${UUID}.md` no mesmo bucket. Consulte `GET /documents/:id` para os estados `QUEUED`, `EXTRACTING`, `EXTRACTED`, `SUMMARIZING`, `CANCELLING`, `CANCELLED`, `COMPLETED` e `FAILED`; baixe os arquivos por `GET /documents/:id/download` e `GET /documents/:id/markdown`. `POST /documents/:id/generate` enfileira uma síntese que a interface recebe incrementalmente pelo SSE. `POST /documents/:id/cancel` solicita a interrupção de uma síntese enfileirada ou em andamento; o estado passa a `CANCELLING` até o worker fechar o stream de inferência e confirmar `CANCELLED`. O worker verifica o pedido antes da inferência e a cada fragmento recebido; durante o processamento inicial do prompt, a confirmação depende do próximo fragmento ou do timeout do cliente HTTP. O texto parcial já recebido continua na prévia e fica no Redis por até 30 dias para reaparecer após recarregar a página; ele não é tratado como síntese concluída nem pode ser salvo no histórico. O resultado concluído também fica temporariamente no Redis e só é salvo no histórico PostgreSQL quando o usuário escolhe **Salvar síntese** (`POST /documents/:id/summaries`).

As abas PUR e RDA da interface usam esse mesmo fluxo. Cada aba envia o respectivo `type`, mostra apenas os documentos daquele tipo e mantém seus próprios tópicos padrão; streaming, cancelamento, prévia Markdown e histórico funcionam nas duas.

Use `pnpm db:deploy` para aplicar migrations existentes fora do desenvolvimento, `pnpm db:studio` para abrir o Prisma Studio e `pnpm db:down` para parar os containers. Os volumes persistem ao parar os serviços; `docker compose down -v` apaga os dados locais.
