/**
 * API Route: /api/intelligence/fitness
 *
 * Management surface for the `user_override` layer of the auto-combo task-fitness
 * resolution chain (open-sse/services/autoCombo/taskFitness.ts). Lets an operator
 * load benchmark-derived fitness (e.g. Terminal-Bench, SWE-bench) for models the
 * DB-backed layers (arena_elo, models_dev_tier) have no opinion on.
 *
 * GET    — no query: list all user_override entries.
 *          ?models=a,b&taskTypes=coding,analysis: resolved fitness + source per
 *          model x task type, via getTaskFitnessWithSource (same chain routing uses).
 * PUT    — body { overrides: [{ model, category, score }] }: write user_override
 *          rows and invalidate the fitness cache so the next request sees them.
 * DELETE — ?model=...&category=...: clear one override.
 *
 * Model id form: overrides are keyed on the exact string auto-combo scores
 * (`candidate.model` in open-sse/services/autoCombo/scoring.ts), which is the raw
 * provider catalog id — no provider prefix (that's `candidate.modelStr`, a
 * different field never used for task-fitness lookups). Examples: NVIDIA's
 * "deepseek-ai/deepseek-v4-pro-0813", Gemini's "gemini-3.8-flash". Matching is
 * case-insensitive (taskFitness.ts lowercases both sides), but NOT prefix- or
 * suffix-aware beyond the scoresAs inheritance already built into the resolution
 * chain (open-sse/services/autoCombo/scoresAs.ts) — an override on a base id is
 * inherited by its effort-suffix/-free variants only when no more specific
 * override exists for the variant itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { putFitnessOverridesSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { listModelIntelligence, getModelIntelligenceBySource } from "@/lib/db/modelIntelligence";
import {
  getTaskFitnessWithSource,
  getTaskTypes,
  setUserFitnessOverride,
  clearUserFitnessOverride,
} from "@omniroute/open-sse/services/autoCombo/taskFitness";

const MODEL_ID_FORM_NOTE =
  'Model ids match candidate.model exactly (the raw provider catalog id, no provider ' +
  'prefix — e.g. "deepseek-ai/deepseek-v4-pro-0813", "gemini-3.8-flash"); matching is case-insensitive.';

// "default" is a real FITNESS_TABLE / TIER_TASK_FITNESS bucket (the fallback
// scored when no more specific category matches) but getTaskTypes() excludes
// it from the "named category" list. It is still a legal argument to
// getTaskFitness, so it stays valid here for both reads and writes.
function validTaskTypes(): string[] {
  return [...getTaskTypes(), "default"];
}

function unknownCategoryResponse(field: string, category: string): NextResponse {
  const valid = validTaskTypes();
  return NextResponse.json(
    {
      error: {
        message: `Unknown task category "${category}". Valid categories: ${valid.join(", ")}`,
        details: [{ field, message: `must be one of: ${valid.join(", ")}` }],
      },
    },
    { status: 400 }
  );
}

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const models = parseCsv(searchParams.get("models"));

    if (models.length === 0) {
      const overrides = listModelIntelligence({ source: "user_override" }).map((entry) => ({
        model: entry.model,
        category: entry.category,
        score: entry.score,
        updatedAt: entry.syncedAt,
      }));
      return NextResponse.json({ overrides, modelIdForm: MODEL_ID_FORM_NOTE });
    }

    const valid = new Set(validTaskTypes());
    const taskTypes = parseCsv(searchParams.get("taskTypes"));
    const effectiveTaskTypes = taskTypes.length > 0 ? taskTypes : getTaskTypes();

    for (const taskType of effectiveTaskTypes) {
      if (!valid.has(taskType)) return unknownCategoryResponse("taskTypes", taskType);
    }

    const resolved = models.flatMap((model) =>
      effectiveTaskTypes.map((taskType) => {
        const hit = getTaskFitnessWithSource(model, taskType);
        return { model, taskType, score: hit.score, source: hit.source };
      })
    );

    return NextResponse.json({ resolved, modelIdForm: MODEL_ID_FORM_NOTE });
  } catch (err) {
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  const validation = validateBody(putFitnessOverridesSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const valid = new Set(validTaskTypes());
  for (const [index, entry] of validation.data.overrides.entries()) {
    if (!valid.has(entry.category)) {
      return unknownCategoryResponse(`overrides.${index}.category`, entry.category);
    }
  }

  try {
    const written = validation.data.overrides.map((entry) => {
      setUserFitnessOverride(entry.model, entry.category, entry.score);
      return {
        model: entry.model.toLowerCase(),
        category: entry.category.toLowerCase(),
        score: entry.score,
      };
    });
    return NextResponse.json({ written, modelIdForm: MODEL_ID_FORM_NOTE });
  } catch (err) {
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const model = searchParams.get("model")?.trim();
    const category = searchParams.get("category")?.trim();

    if (!model || !category) {
      return NextResponse.json(
        {
          error: {
            message: "Invalid request",
            details: [
              ...(!model ? [{ field: "model", message: "model query param is required" }] : []),
              ...(!category
                ? [{ field: "category", message: "category query param is required" }]
                : []),
            ],
          },
        },
        { status: 400 }
      );
    }

    const valid = new Set(validTaskTypes());
    if (!valid.has(category)) return unknownCategoryResponse("category", category);

    const existed =
      getModelIntelligenceBySource(model.toLowerCase(), "user_override", category.toLowerCase()) !==
      null;
    clearUserFitnessOverride(model, category);

    return NextResponse.json({ existed, model: model.toLowerCase(), category: category.toLowerCase() });
  } catch (err) {
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
  }
}
