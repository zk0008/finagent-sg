"""
evaluate_rag.py — RAG Pipeline Evaluation using RAGAS

What this script measures
--------------------------
RAGAS (Retrieval-Augmented Generation Assessment) evaluates four dimensions
of a RAG pipeline without requiring human-labelled judgements for most metrics:

  faithfulness       — Is the generated answer faithful to the retrieved context?
                       Measures whether the answer contains claims that are NOT
                       supported by the retrieved chunks. Score 1.0 = fully grounded.

  answer_relevancy   — Is the generated answer relevant to the question?
                       Measures whether the answer actually addresses what was asked.
                       Score 1.0 = directly answers the question.

  context_precision  — Are the retrieved chunks precise (signal over noise)?
                       Measures how many of the retrieved chunks are actually useful
                       for answering the question. Score 1.0 = all chunks are relevant.

  context_recall     — Does the retrieved context cover the expected answer?
                       Compares retrieved chunks against the ground_truth answer to
                       check if the key facts are present in the context.
                       Score 1.0 = context contains everything needed.

How to interpret scores
------------------------
  0.8 – 1.0  Excellent — RAG is retrieving and answering well
  0.6 – 0.8  Good — minor improvements needed (add more docs, tune chunk size)
  0.4 – 0.6  Fair — consider ingesting more documents or adjusting chunking
  0.0 – 0.4  Poor — knowledge base needs significantly more content

Results are saved to ml/rag_evaluation_results.csv after each run.
"""

import os
import json
import csv
from dotenv import load_dotenv

# Load environment variables from ml/.env
# Must be called before any other imports that read env vars
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

import chromadb
from openai import OpenAI
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy, context_precision, context_recall

# ── Configuration ─────────────────────────────────────────────────────────────

CHROMA_HOST       = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT       = int(os.getenv("CHROMA_PORT", "8000"))
CHROMA_COLLECTION = os.getenv("CHROMA_COLLECTION", "sfrs_knowledge")
OPENAI_API_KEY    = os.getenv("OPENAI_API_KEY")

# Must match the embedding model used in the Next.js ingestion pipeline (lib/ingest.ts)
EMBEDDING_MODEL = "text-embedding-3-small"

# Answer generation model — same as chatbot question path in app/api/chat/route.ts
ANSWER_MODEL = "gpt-4.1-mini"

# Number of chunks to retrieve per question — matches app/api/chat/route.ts (nResults=4)
TOP_K = 5

# Output file path (relative to ml/ directory)
OUTPUT_CSV = os.path.join(os.path.dirname(__file__), "rag_evaluation_results.csv")

# ── Validate environment ───────────────────────────────────────────────────────

if not OPENAI_API_KEY:
    raise EnvironmentError(
        "OPENAI_API_KEY is not set.\n"
        "Copy ml/.env.example to ml/.env and fill in your API key."
    )

# ── Clients ───────────────────────────────────────────────────────────────────

# OpenAI client — used for embeddings and answer generation
openai_client = OpenAI(api_key=OPENAI_API_KEY)

# ChromaDB client — connects to local Docker instance
print(f"Connecting to ChromaDB at {CHROMA_HOST}:{CHROMA_PORT}...")
chroma_client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

# Load the knowledge base collection
try:
    collection = chroma_client.get_collection(name=CHROMA_COLLECTION)
    print(f"Connected to collection '{CHROMA_COLLECTION}' ({collection.count()} chunks)")
except Exception as e:
    raise RuntimeError(
        f"Could not connect to ChromaDB collection '{CHROMA_COLLECTION}'.\n"
        f"Make sure ChromaDB is running and documents are ingested:\n"
        f"  docker compose --env-file docker-compose.env up -d\n"
        f"  npx tsx scripts/ingest.ts (from project root)\n\n"
        f"Original error: {e}"
    )

# ── Load test questions ────────────────────────────────────────────────────────

questions_path = os.path.join(os.path.dirname(__file__), "test_questions.json")
with open(questions_path, "r", encoding="utf-8") as f:
    test_cases = json.load(f)

print(f"Loaded {len(test_cases)} test questions.\n")

# ── Step 1: Embed each question using text-embedding-3-small ──────────────────
# This must be the same model used during document ingestion in lib/ingest.ts.
# Using a different model would produce incompatible embedding spaces and
# degrade retrieval quality artificially.

def embed_query(text: str) -> list[float]:
    """Embed a single query string using text-embedding-3-small."""
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
    )
    return response.data[0].embedding


# ── Step 2: Retrieve top-K chunks from ChromaDB for each question ─────────────

def retrieve_chunks(question: str) -> list[str]:
    """
    Query ChromaDB for the TOP_K most relevant document chunks.
    Returns a list of chunk text strings.
    """
    query_embedding = embed_query(question)
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=TOP_K,
        include=["documents"],
    )
    # results["documents"] is a list of lists (one list per query)
    chunks = results["documents"][0] if results["documents"] else []
    return chunks


# ── Step 3: Generate an answer using GPT-4.1-mini + retrieved context ─────────

def generate_answer(question: str, context_chunks: list[str]) -> str:
    """
    Generate an answer for the question using retrieved context.
    Mirrors the system prompt used in app/api/chat/route.ts (question path).
    """
    context_text = "\n\n---\n\n".join(context_chunks) if context_chunks else "No relevant content found."

    system_prompt = (
        "You are an expert Singapore chartered accountant assistant for FinAgent-SG.\n"
        "Answer accounting questions accurately and concisely, focusing on Singapore SFRS standards,\n"
        "IRAS tax guidance, ACRA filing requirements, and CPF/payroll rules.\n\n"
        "Use the following retrieved knowledge base content to answer the question:\n\n"
        "--- KNOWLEDGE BASE ---\n"
        f"{context_text}\n"
        "--- END KNOWLEDGE BASE ---\n\n"
        "If the knowledge base does not contain relevant information, answer from your general Singapore accounting knowledge.\n"
        "Keep answers concise — 2–4 sentences unless more detail is clearly needed."
    )

    response = openai_client.chat.completions.create(
        model=ANSWER_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ],
        temperature=0,  # Deterministic output for evaluation
    )
    return response.choices[0].message.content.strip()


# ── Step 4: Run all questions through the pipeline ────────────────────────────

print("Running RAG pipeline for each question...")
print("-" * 60)

eval_rows = []  # Will be passed to RAGAS

for i, case in enumerate(test_cases):
    question     = case["question"]
    ground_truth = case["expected_answer"]

    print(f"[{i+1}/{len(test_cases)}] {question[:70]}...")

    # Retrieve relevant chunks from ChromaDB
    contexts = retrieve_chunks(question)

    # Generate an answer grounded in the retrieved context
    answer = generate_answer(question, contexts)

    eval_rows.append({
        "question":     question,
        "answer":       answer,
        "contexts":     contexts,      # List of strings — RAGAS expects this format
        "ground_truth": ground_truth,
    })

print("-" * 60)
print(f"Pipeline complete. Running RAGAS evaluation on {len(eval_rows)} samples...\n")

# ── Step 5: Run RAGAS evaluation ──────────────────────────────────────────────
# RAGAS expects a HuggingFace Dataset with columns:
#   question, answer, contexts (list[str]), ground_truth

dataset = Dataset.from_list(eval_rows)

# Evaluate all four metrics
# RAGAS will call OpenAI internally using OPENAI_API_KEY from environment
result = evaluate(
    dataset=dataset,
    metrics=[
        faithfulness,
        answer_relevancy,
        context_precision,
        context_recall,
    ],
)

# Convert result to a pandas DataFrame for display and export.
# RAGAS to_pandas() only returns metric score columns — no question column.
# Merge the original questions back in by index position.
scores_df = result.to_pandas()
questions = [r["question"] for r in eval_rows]
scores_df.insert(0, "question", questions)
df = scores_df

# ── Step 6: Print results table ───────────────────────────────────────────────

METRIC_COLS = ["faithfulness", "answer_relevancy", "context_precision", "context_recall"]

print("\n" + "=" * 90)
print(f"{'#':<4} {'Question':<45} {'Faith':>6} {'AnswRel':>8} {'CtxPrc':>8} {'CtxRec':>8}")
print("=" * 90)

for i, row in df.iterrows():
    q_short = row["question"][:43] + ".." if len(row["question"]) > 45 else row["question"]
    faith   = row.get("faithfulness", float("nan"))
    ansrel  = row.get("answer_relevancy", float("nan"))
    ctxprc  = row.get("context_precision", float("nan"))
    ctxrec  = row.get("context_recall", float("nan"))
    print(f"{i+1:<4} {q_short:<45} {faith:>6.3f} {ansrel:>8.3f} {ctxprc:>8.3f} {ctxrec:>8.3f}")

print("-" * 90)

# Calculate averages
avg_faith  = df["faithfulness"].mean()
avg_ansrel = df["answer_relevancy"].mean()
avg_ctxprc = df["context_precision"].mean()
avg_ctxrec = df["context_recall"].mean()
overall    = (avg_faith + avg_ansrel + avg_ctxprc + avg_ctxrec) / 4

print(f"{'AVG':<4} {'':<45} {avg_faith:>6.3f} {avg_ansrel:>8.3f} {avg_ctxprc:>8.3f} {avg_ctxrec:>8.3f}")
print("=" * 90)
print(f"\nOverall RAG Quality Score: {overall:.3f} / 1.000")

# ── Step 7: Save results to CSV ───────────────────────────────────────────────

csv_cols = ["question", "faithfulness", "answer_relevancy", "context_precision", "context_recall"]
df[csv_cols].to_csv(OUTPUT_CSV, index=False)
print(f"\nResults saved to: {OUTPUT_CSV}")

# ── Step 8: Print interpretation guide ────────────────────────────────────────

print("\n── Score Interpretation ─────────────────────────────────────────────────────")
print("  0.8 – 1.0  Excellent — RAG is retrieving and answering well")
print("  0.6 – 0.8  Good      — minor improvements needed")
print("  0.4 – 0.6  Fair      — consider ingesting more documents or adjusting chunking")
print("  0.0 – 0.4  Poor      — knowledge base needs significantly more content")
print("─────────────────────────────────────────────────────────────────────────────\n")
