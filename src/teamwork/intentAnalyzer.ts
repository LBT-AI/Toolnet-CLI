/**
 * Intent & Complexity Analyzer for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/intentAnalyzer.ts
 */

import type {
  ExecutionMode,
  IntentAnalysisResult,
  IntentComplexityBreakdown,
  AgentRole,
} from './types';

// Keywords & RegEx patterns for heuristic evaluation
const TINY_VERBS = /\b(?:rename|typo|format|clean|print|export|comment|bump)\b/gi;
const MEDIUM_VERBS = /\b(?:add|update|modify|create|implement|fix|extract|change)\b/gi;
const COMPLEX_VERBS = /\b(?:refactor|architect|build|migrate|optimize|overhaul|audit|redesign|integrate|benchmark)\b/gi;

const FILE_PATTERN = /[\w\-./\\]+\.(ts|tsx|js|jsx|json|md|py|sh|css|html|sql|yaml|yml)/gi;
const WILDCARD_SCOPE = /\b(all\s+files|directory|folder|src\/|across|codebase|entire|project-wide|workspace)\b/i;

const MULTI_STEP_CONNECTORS = /\b(then|after\s+that|followed\s+by|first|second|third|finally|next|and\s+also)\b/gi;
const NUMBERED_LIST_PATTERN = /(?:\d+\.|\*|-)\s+/g;

export interface IntentAnalyzerOptions {
  forceMode?: ExecutionMode;
}

/**
 * Analyzes user prompt complexity and selects appropriate ExecutionMode in <5ms.
 */
export function analyzeIntent(
  prompt: string,
  options?: IntentAnalyzerOptions
): IntentAnalysisResult {
  const analyzedAt = Date.now();
  const trimmed = prompt.trim();
  const reasons: string[] = [];

  if (options?.forceMode) {
    const forcedScore = options.forceMode === 'TURBO' ? 10 : options.forceMode === 'STANDARD' ? 40 : 80;
    return {
      score: forcedScore,
      complexityScore: forcedScore,
      mode: options.forceMode,
      reasons: [`Execution mode forcibly set to '${options.forceMode}' via options.`],
      rationale: `Execution mode forcibly set to '${options.forceMode}' via options.`,
      breakdown: { promptLengthScore: 0, actionVerbScore: 0, fileTargetScore: 0, multiStepScore: 0 },
      extractedFileTargets: [],
      extractedKeywords: [],
      requiresPlanner: options.forceMode !== 'TURBO',
      requiresQA: options.forceMode !== 'TURBO',
      suggestedRoles: options.forceMode === 'TURBO' ? ['worker'] : ['explorer', 'worker', 'reviewer'],
      analyzedAt,
    };
  }

  // 1. Calculate Prompt Length Score (0 - 25 pts)
  const charLength = trimmed.length;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  let promptLengthScore = 0;

  if (charLength < 30 || wordCount < 6) {
    promptLengthScore = 2;
    reasons.push(`Prompt is very short (${charLength} chars, ${wordCount} words).`);
  } else if (charLength < 80 || wordCount < 15) {
    promptLengthScore = 8;
    reasons.push(`Prompt is short (${charLength} chars, ${wordCount} words).`);
  } else if (charLength < 200 || wordCount < 40) {
    promptLengthScore = 16;
    reasons.push(`Prompt is medium length (${charLength} chars, ${wordCount} words).`);
  } else {
    promptLengthScore = 25;
    reasons.push(`Prompt is detailed/long (${charLength} chars, ${wordCount} words).`);
  }

  // 2. Calculate Action Verb Score (0 - 25 pts)
  let actionVerbScore = 0;
  const extractedKeywords: string[] = [];

  const complexMatches = trimmed.match(COMPLEX_VERBS);
  if (complexMatches) {
    actionVerbScore += complexMatches.length * 15;
    extractedKeywords.push(...complexMatches.map(m => m.toLowerCase()));
    reasons.push(`Detected complex action verb(s): ${complexMatches.join(', ')}.`);
  }

  const mediumMatches = trimmed.match(MEDIUM_VERBS);
  if (mediumMatches) {
    actionVerbScore += mediumMatches.length * 8;
    extractedKeywords.push(...mediumMatches.map(m => m.toLowerCase()));
    reasons.push(`Detected standard action verb(s): ${mediumMatches.join(', ')}.`);
  }

  const tinyMatches = trimmed.match(TINY_VERBS);
  if (tinyMatches) {
    actionVerbScore += tinyMatches.length * 3;
    extractedKeywords.push(...tinyMatches.map(m => m.toLowerCase()));
    reasons.push(`Detected simple action verb(s): ${tinyMatches.join(', ')}.`);
  }
  actionVerbScore = Math.min(25, actionVerbScore);

  // 3. Calculate File Target Scope Score (0 - 25 pts)
  let fileTargetScore = 0;
  const fileMatches = Array.from(new Set(trimmed.match(FILE_PATTERN) || []));
  const extractedFileTargets: string[] = [...fileMatches];

  if (WILDCARD_SCOPE.test(trimmed)) {
    fileTargetScore = 20;
    reasons.push('Broad/workspace-wide target scope detected.');
  } else if (fileMatches.length > 2) {
    fileTargetScore = 15;
    reasons.push(`Multiple file targets detected (${fileMatches.length} files).`);
  } else if (fileMatches.length === 2) {
    fileTargetScore = 10;
    reasons.push(`Two explicit file targets detected.`);
  } else if (fileMatches.length === 1) {
    fileTargetScore = 3;
    reasons.push(`Single explicit file target detected (${fileMatches[0]}).`);
  }

  // 4. Calculate Multi-Step Indicator Score (0 - 25 pts)
  let multiStepScore = 0;
  const connectorMatches = trimmed.match(MULTI_STEP_CONNECTORS);
  if (connectorMatches) {
    multiStepScore += connectorMatches.length * 6;
    reasons.push(`Detected multi-step connectors: ${connectorMatches.join(', ')}.`);
  }

  const listMatches = trimmed.match(NUMBERED_LIST_PATTERN);
  if (listMatches) {
    multiStepScore += 12;
    reasons.push('Detected numbered/bullet task list structure.');
  }

  const sentenceCount = trimmed.split(/[.!?\n]+/).filter(s => s.trim().length > 0).length;
  if (sentenceCount > 2) {
    multiStepScore += (sentenceCount - 2) * 4;
  }
  multiStepScore = Math.min(25, multiStepScore);

  // Calculate Total Score (capped 0 - 100)
  const totalScore = Math.min(
    100,
    Math.max(0, promptLengthScore + actionVerbScore + fileTargetScore + multiStepScore)
  );

  const breakdown: IntentComplexityBreakdown = {
    promptLengthScore,
    actionVerbScore,
    fileTargetScore,
    multiStepScore,
  };

  // Determine Execution Mode & Requirements
  let mode: ExecutionMode = 'STANDARD';
  let requiresPlanner = true;
  let requiresQA = true;
  let suggestedRoles: AgentRole[] = ['explorer', 'worker', 'reviewer'];

  if (totalScore < 20) {
    mode = 'TURBO';
    requiresPlanner = false;
    requiresQA = false;
    suggestedRoles = ['worker'];
    reasons.push(`Total complexity score ${totalScore} < 20 -> TURBO Mode selected (bypassing planner & QA).`);
  } else if (totalScore >= 60) {
    mode = 'COMPLEX';
    requiresPlanner = true;
    requiresQA = true;
    suggestedRoles = ['explorer', 'planner', 'worker', 'reviewer', 'auditor'];
    reasons.push(`Total complexity score ${totalScore} >= 60 -> COMPLEX Mode selected.`);
  } else {
    reasons.push(`Total complexity score ${totalScore} (20-59) -> STANDARD Mode selected.`);
  }

  const rationale = reasons.join(' ');

  return {
    score: totalScore,
    complexityScore: totalScore,
    mode,
    reasons,
    rationale,
    breakdown,
    extractedFileTargets,
    extractedKeywords: Array.from(new Set(extractedKeywords)),
    requiresPlanner,
    requiresQA,
    suggestedRoles,
    analyzedAt,
  };
}
