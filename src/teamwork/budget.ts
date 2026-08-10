import type { QualityLevel } from "./types";

export interface BudgetConfig {
  maxTokens?: number;
  maxDurationMs?: number;
  qualityLevel: QualityLevel;
}

export class BudgetManager {
  private config: BudgetConfig;
  private currentTokens: number = 0;
  private startTime: number = Date.now();

  constructor(config: BudgetConfig) {
    this.config = config;
  }

  addTokens(tokens: number) {
    this.currentTokens += tokens;
  }

  isTokenBudgetExhausted(): boolean {
    if (!this.config.maxTokens) return false;
    return this.currentTokens >= this.config.maxTokens;
  }

  isTimeBudgetExhausted(): boolean {
    if (!this.config.maxDurationMs) return false;
    return (Date.now() - this.startTime) >= this.config.maxDurationMs;
  }

  getRemainingTimeMs(): number | null {
    if (!this.config.maxDurationMs) return null;
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.config.maxDurationMs - elapsed);
  }

  getMaxReviewRounds(): number {
    switch (this.config.qualityLevel) {
      case 'FAST':
      case 'DRAFT':
        return 0; // No QA
      case 'BALANCED':
      case 'NORMAL':
        return 1;
      case 'THOROUGH':
      case 'HIGH':
      case 'MAX':
        return 2;
      default:
        return 1;
    }
  }
}
