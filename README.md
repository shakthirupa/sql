# SQL Arena

Author side: write a question, schema and reference solution, then let Groq's AI generate the toughest test cases.
Friend side: read questions, write SQL, run on the sample, submit against all tests.

## Run locally (Node 20+)
    cp .env.example .env      # set ADMIN_PASSWORD and GROQ_API_KEY
    npm install
    npm run dev               # http://localhost:3000

## Use
Quick way: paste the question in any format (exam boilerplate, "Q84", required output columns, schema hint like employee(EMPID, EMPNAME, ...) all work), click **Auto-fill everything from this question**. The AI drafts the schema, reference solution and tests, and the server verifies them. Review the AI's assumptions and the expected output, edit anything, then save.
Manual way:
1. Open the site, click **Author**, log in with ADMIN_PASSWORD.
2. New problem: title, question, CREATE TABLE schema, reference SELECT.
3. Click **Generate toughest test cases**. The AI writes adversarial datasets, the server runs your
   solution on each (broken ones are discarded) and tests each against 6+ typical wrong queries.
   "Catches N" shows how many wrong queries each test exposes. Edit or remove tests, then Save.
4. Send your friend the site URL. They use **Practice** (no login).

## Deploy
Needs a host that runs Node and has a persistent disk (SQLite file lives in DATA_DIR).
- Render / Railway / Fly.io: deploy this folder (Dockerfile included), set env vars
  ADMIN_PASSWORD, GROQ_API_KEY, mount a volume at /data.
- Never commit .env. The API key stays on the server.

## Safety built in
Student queries run in a throwaway in-memory SQLite, SELECT/WITH only, read-only, in a worker thread with a 3s kill timeout.
Notes: SQLite dialect. Hidden tests (2+) are never sent to the browser.

AI: uses Groq (OpenAI-compatible). Get a key at console.groq.com/keys. Change GROQ_MODEL to any chat model on your Groq account.

Column names: tick "Require exact column names" to grade output column names letter for letter (case-insensitive). The auto-fill ticks it whenever the question lists required output columns.
