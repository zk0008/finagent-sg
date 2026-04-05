# FinAgent-SG — ML RAG Evaluation Pipeline

This folder contains a Python-based evaluation pipeline for the FinAgent-SG RAG (Retrieval-Augmented Generation) system. It uses [RAGAS](https://docs.ragas.io/) to measure how well the ChromaDB knowledge base retrieves relevant Singapore accounting content and how faithfully the AI generates answers from it.

This pipeline is **separate from the Next.js application** — it is run manually by developers and does not affect the running app.

---

## Prerequisites

- Python 3.8 or higher
- ChromaDB must be running locally via Docker
- Documents must be ingested into ChromaDB before evaluating

---

## Setup

```bash
# 1. Navigate to the ml folder
cd ml

# 2. Create a virtual environment
python3 -m venv venv

# 3. Activate the virtual environment
source venv/bin/activate       # Mac / Linux
# venv\Scripts\activate        # Windows

# 4. Install dependencies
pip install -r requirements.txt

# 5. Create your .env file from the example
cp .env.example .env

# 6. Fill in your OpenAI API key in .env
#    Open ml/.env and set: OPENAI_API_KEY=sk-your-key-here

# 7. Make sure ChromaDB is running (from the project root)
docker compose --env-file docker-compose.env up -d

# 8. Make sure documents are ingested into ChromaDB (from the project root)
npx tsx scripts/ingest.ts

# 9. Run the evaluation
python3 evaluate_rag.py
```

---

## How to Interpret Scores

RAGAS measures four metrics, each scored from 0.0 to 1.0:

| Metric | What it measures |
|--------|-----------------|
| **faithfulness** | Is the answer grounded in the retrieved context? (1.0 = no hallucination) |
| **answer_relevancy** | Does the answer actually address the question? |
| **context_precision** | Are the retrieved chunks relevant (signal over noise)? |
| **context_recall** | Does the context contain everything needed to answer? |

**Score guide:**

| Range | Interpretation |
|-------|---------------|
| 0.8 – 1.0 | Excellent — RAG is retrieving and answering well |
| 0.6 – 0.8 | Good — minor improvements needed (add docs, tune chunk size) |
| 0.4 – 0.6 | Fair — consider ingesting more documents |
| 0.0 – 0.4 | Poor — knowledge base needs significantly more content |

---

## Output

- Results are printed to the terminal as a table after the run completes.
- Results are also saved to `ml/rag_evaluation_results.csv` (gitignored — contains generated data, not source code).

---

## Files

| File | Purpose |
|------|---------|
| `evaluate_rag.py` | Main evaluation script |
| `test_questions.json` | 10 SG accounting test questions with expected answers |
| `requirements.txt` | Python dependencies |
| `.env.example` | Environment variable template |
| `.env` | Your local secrets (gitignored — never commit) |
| `rag_evaluation_results.csv` | Generated results (gitignored) |
