/**
 * MissionStore — SQLite-backed persistence for autonomous missions.
 *
 * Stores mission goals, strategies, execution history, and methodology.
 * The model creates and evolves missions; the store just persists state.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// ── Types ──────────────────────────────────────────────────────

export interface MissionStep {
  timestamp: number;
  action: string;
  result: string;
  learning: string;
  success: boolean;
}

export interface Mission {
  id: string;
  goal: string;
  status: 'active' | 'paused' | 'completed';
  context: string;
  currentStrategy: string;
  nextAction: string;
  nextRunAt: number;
  runIntervalMs: number;
  history: MissionStep[];
  methodology: string;
  sourceChannel: string;
  sourceReplyTo: string;
  createdAt: number;
  updatedAt: number;
}

// ── Schema SQL ─────────────────────────────────────────────────

export const MISSION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    context TEXT NOT NULL DEFAULT '',
    current_strategy TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    next_run_at INTEGER NOT NULL DEFAULT 0,
    run_interval_ms INTEGER NOT NULL DEFAULT 1800000,
    methodology TEXT NOT NULL DEFAULT '',
    source_channel TEXT NOT NULL DEFAULT 'terminal',
    source_reply_to TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
  CREATE INDEX IF NOT EXISTS idx_missions_next_run_at ON missions(next_run_at);

  CREATE TABLE IF NOT EXISTS mission_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    learning TEXT NOT NULL DEFAULT '',
    success INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mission_steps_mission_id ON mission_steps(mission_id);
  CREATE INDEX IF NOT EXISTS idx_mission_steps_timestamp ON mission_steps(timestamp);
`;

// ── Row types ──────────────────────────────────────────────────

interface MissionRow {
  id: string;
  goal: string;
  status: string;
  context: string;
  current_strategy: string;
  next_action: string;
  next_run_at: number;
  run_interval_ms: number;
  methodology: string;
  source_channel: string;
  source_reply_to: string;
  created_at: number;
  updated_at: number;
}

interface StepRow {
  id: number;
  mission_id: string;
  timestamp: number;
  action: string;
  result: string;
  learning: string;
  success: number;
}

// ── MissionStore ───────────────────────────────────────────────

export class MissionStore {
  private stmtInsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtUpdate: Database.Statement;
  private stmtListActive: Database.Statement;
  private stmtListAll: Database.Statement;
  private stmtAddStep: Database.Statement;
  private stmtGetSteps: Database.Statement;
  private stmtUpdateMethodology: Database.Statement;
  private stmtGetDue: Database.Statement;
  private stmtStepCount: Database.Statement;

  // In-memory flag: missions that should continue immediately after current run
  private continueFlags = new Set<string>();

  setContinueFlag(id: string): void { this.continueFlags.add(id); }
  hasContinueFlag(id: string): boolean { return this.continueFlags.has(id); }
  clearContinueFlag(id: string): void { this.continueFlags.delete(id); }

  constructor(private db: Database.Database) {
    // Ensure tables exist
    db.exec(MISSION_SCHEMA_SQL);

    this.stmtInsert = db.prepare(`
      INSERT INTO missions (id, goal, status, context, current_strategy, next_action, next_run_at, run_interval_ms, methodology, source_channel, source_reply_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGet = db.prepare('SELECT * FROM missions WHERE id = ?');

    this.stmtUpdate = db.prepare(`
      UPDATE missions SET
        status = ?, current_strategy = ?, next_action = ?,
        next_run_at = ?, run_interval_ms = ?, methodology = ?,
        context = ?, updated_at = ?
      WHERE id = ?
    `);

    this.stmtListActive = db.prepare("SELECT * FROM missions WHERE status = 'active' ORDER BY next_run_at ASC");
    this.stmtListAll = db.prepare('SELECT * FROM missions ORDER BY updated_at DESC');

    this.stmtAddStep = db.prepare(`
      INSERT INTO mission_steps (mission_id, timestamp, action, result, learning, success)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetSteps = db.prepare(
      'SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY timestamp DESC LIMIT ?'
    );

    this.stmtUpdateMethodology = db.prepare(
      'UPDATE missions SET methodology = ?, updated_at = ? WHERE id = ?'
    );

    this.stmtGetDue = db.prepare(
      "SELECT * FROM missions WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC"
    );

    this.stmtStepCount = db.prepare('SELECT COUNT(*) as count FROM mission_steps WHERE mission_id = ?');
  }

  create(params: {
    goal: string;
    context?: string;
    runIntervalMs?: number;
    initialStrategy?: string;
    sourceChannel?: string;
    sourceReplyTo?: string;
  }): Mission {
    const id = randomUUID();
    const now = Date.now();
    const intervalMs = params.runIntervalMs ?? 1800000; // 30 min default
    const sourceChannel = params.sourceChannel ?? 'terminal';
    const sourceReplyTo = params.sourceReplyTo ?? 'user';

    this.stmtInsert.run(
      id,
      params.goal,
      'active',
      params.context ?? '',
      params.initialStrategy ?? '',
      '',
      now, // nextRunAt = now (execute immediately)
      intervalMs,
      '',
      sourceChannel,
      sourceReplyTo,
      now,
      now,
    );

    return {
      id,
      goal: params.goal,
      status: 'active',
      context: params.context ?? '',
      currentStrategy: params.initialStrategy ?? '',
      nextAction: '',
      nextRunAt: now,
      runIntervalMs: intervalMs,
      history: [],
      methodology: '',
      sourceChannel,
      sourceReplyTo,
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): Mission | null {
    const row = this.stmtGet.get(id) as MissionRow | undefined;
    if (!row) return null;
    return this.rowToMission(row);
  }

  update(id: string, updates: Partial<Pick<Mission,
    'status' | 'currentStrategy' | 'nextAction' | 'nextRunAt' |
    'runIntervalMs' | 'methodology' | 'context'
  >>): Mission | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = Date.now();
    this.stmtUpdate.run(
      updates.status ?? existing.status,
      updates.currentStrategy ?? existing.currentStrategy,
      updates.nextAction ?? existing.nextAction,
      updates.nextRunAt ?? existing.nextRunAt,
      updates.runIntervalMs ?? existing.runIntervalMs,
      updates.methodology ?? existing.methodology,
      updates.context ?? existing.context,
      now,
      id,
    );

    return this.get(id);
  }

  listActive(): Mission[] {
    const rows = this.stmtListActive.all() as MissionRow[];
    return rows.map(r => this.rowToMission(r));
  }

  listAll(): Mission[] {
    const rows = this.stmtListAll.all() as MissionRow[];
    return rows.map(r => this.rowToMission(r));
  }

  addStep(missionId: string, step: MissionStep): void {
    this.stmtAddStep.run(
      missionId,
      step.timestamp,
      step.action,
      step.result,
      step.learning,
      step.success ? 1 : 0,
    );
    // Touch updatedAt
    this.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(Date.now(), missionId);
  }

  getSteps(missionId: string, limit = 20): MissionStep[] {
    const rows = this.stmtGetSteps.all(missionId, limit) as StepRow[];
    return rows.map(r => ({
      timestamp: r.timestamp,
      action: r.action,
      result: r.result,
      learning: r.learning,
      success: r.success === 1,
    }));
  }

  getStepCount(missionId: string): number {
    return (this.stmtStepCount.get(missionId) as { count: number }).count;
  }

  updateMethodology(id: string, methodology: string): void {
    const truncated = methodology.length > 3000 ? methodology.slice(-3000) : methodology;
    this.stmtUpdateMethodology.run(truncated, Date.now(), id);
  }

  getDueMissions(now?: number): Mission[] {
    const rows = this.stmtGetDue.all(now ?? Date.now()) as MissionRow[];
    return rows.map(r => this.rowToMission(r));
  }

  archiveOldSteps(missionId: string, keepRecent: number = 200): number {
    const total = this.getStepCount(missionId);
    if (total <= keepRecent + 100) return 0;

    const oldSteps = this.db.prepare(
      "SELECT learning FROM mission_steps WHERE mission_id = ? AND learning != '' ORDER BY timestamp ASC LIMIT ?"
    ).all(missionId, total - keepRecent) as { learning: string }[];

    const mergedLearning = oldSteps.map(s => s.learning).filter(Boolean).join('\n');

    const deleteCount = this.db.prepare(`
      DELETE FROM mission_steps WHERE mission_id = ? AND id NOT IN (
        SELECT id FROM mission_steps WHERE mission_id = ? ORDER BY timestamp DESC LIMIT ?
      )
    `).run(missionId, missionId, keepRecent).changes;

    return deleteCount;
  }

  /** Get a text summary of all active missions for context injection. */
  getActiveMissionsSummary(): string {
    const active = this.listActive();
    if (active.length === 0) return '';

    const parts = active.map(m => {
      const recentSteps = m.history.slice(0, 5);
      const stepsBlock = recentSteps.length > 0
        ? recentSteps.map(s => {
          const status = s.success ? 'OK' : 'FAIL';
          return `  - [${status}] ${s.action}: ${s.result.slice(0, 100)}`;
        }).join('\n')
        : '  (no steps yet)';

      const methodologyPreview = m.methodology ? m.methodology.slice(0, 200) : '(none)';

      return [
        `### Mission: ${m.goal}`,
        `- ID: ${m.id}`,
        `- Strategy: ${m.currentStrategy || '(none)'}`,
        `- Methodology: ${methodologyPreview}`,
        `- Recent steps:\n${stepsBlock}`,
      ].join('\n');
    });

    return parts.join('\n\n');
  }

  private rowToMission(row: MissionRow): Mission {
    const steps = this.getSteps(row.id, 50);
    return {
      id: row.id,
      goal: row.goal,
      status: row.status as Mission['status'],
      context: row.context,
      currentStrategy: row.current_strategy,
      nextAction: row.next_action,
      nextRunAt: row.next_run_at,
      runIntervalMs: row.run_interval_ms,
      history: steps,
      methodology: row.methodology,
      sourceChannel: row.source_channel ?? 'terminal',
      sourceReplyTo: row.source_reply_to ?? 'user',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
