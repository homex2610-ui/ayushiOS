import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { TaskItem, TaskStatus, Intent } from './IntentTypes.js';
import { executeCommand } from '../agent/commands/index.js';
import { containsCommand } from '../agent/commands/index.js';

const TASK_FILE = 'tasks.json';

export class TaskQueue {
    constructor(agent) {
        this.agent = agent;
        this.tasks = [];
        this._currentTask = null;
        this._processing = false;
        this._dataDir = path.join(process.cwd(), 'data');
        this._ensureDataDir();
        this._load();
    }

    _ensureDataDir() {
        if (!existsSync(this._dataDir)) {
            mkdirSync(this._dataDir, { recursive: true });
        }
    }

    _getFilePath() {
        const name = this.agent?.name || 'default';
        return path.join(this._dataDir, `${name}_${TASK_FILE}`);
    }

    _load() {
        try {
            const filepath = this._getFilePath();
            if (existsSync(filepath)) {
                const data = JSON.parse(readFileSync(filepath, 'utf8'));
                if (Array.isArray(data)) {
                    let changed = false;
                    const MAX_RESUMES = 2;
                    this.tasks = data.map(t => {
                        const task = TaskItem.fromJSON(t);
                        if (task.status === TaskStatus.RUNNING) {
                            task.status = TaskStatus.PENDING;
                            task.resumed = true;
                            task.resumeCount = (task.resumeCount || 0) + 1;
                            if (task.resumeCount > MAX_RESUMES) {
                                task.status = TaskStatus.FAILED;
                                task.error = 'Exceeded max resume attempts';
                                console.warn(`[TaskQueue] Task "${task.description}" FAILED: too many resumes (${task.resumeCount})`);
                            }
                            changed = true;
                        }
                        return task;
                    }).filter(t => !t.isDone);
                    if (changed) this.save();
                    console.log(`[TaskQueue] Loaded ${this.tasks.length} pending tasks from disk`);
                    if (this.tasks.length > 0) {
                        console.log(`[TaskQueue] Next task: "${this.tasks[0].description}" (${this.tasks[0].intent})`);
                    }
                }
            }
        } catch (e) {
            console.warn(`[TaskQueue] Failed to load tasks: ${e.message}`);
            this.tasks = [];
        }
    }

    save() {
        try {
            const filepath = this._getFilePath();
            const data = this.tasks.filter(t => !t.isDone).map(t => t.toJSON());
            writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.warn(`[TaskQueue] Failed to save tasks: ${e.message}`);
        }
    }

    add(intent, description, steps = []) {
        const task = new TaskItem(intent, description, steps);
        this.tasks.push(task);
        this.save();
        console.log(`[TaskQueue] Added task: "${description}" (${steps.length} steps, ${intent})`);
        return task;
    }

    addSteps(intent, description, steps) {
        return this.add(intent, description, steps);
    }

    cancel(id) {
        const idx = this.tasks.findIndex(t => t.id === id);
        if (idx !== -1) {
            this.tasks[idx].status = TaskStatus.CANCELLED;
            if (this._currentTask && this._currentTask.id === id) {
                this._currentTask = null;
                this._processing = false;
            }
            this.save();
            console.log(`[TaskQueue] Cancelled task: ${this.tasks[idx].description}`);
            return true;
        }
        return false;
    }

    cancelAll() {
        for (const task of this.tasks) {
            task.status = TaskStatus.CANCELLED;
        }
        this._currentTask = null;
        this._processing = false;
        this.save();
        console.log('[TaskQueue] Cancelled all tasks');
    }

    clear() {
        this.tasks = [];
        this._currentTask = null;
        this._processing = false;
        this.save();
    }

    get pending() {
        return this.tasks.filter(t => t.status === TaskStatus.PENDING);
    }

    get active() {
        return this._currentTask;
    }

    get hasPending() {
        return this.pending.length > 0;
    }

    get stats() {
        const total = this.tasks.length;
        const pending = this.pending.length;
        const completed = this.tasks.filter(t => t.status === TaskStatus.COMPLETED).length;
        const failed = this.tasks.filter(t => t.status === TaskStatus.FAILED).length;
        return { total, pending, completed, failed, active: !!this._currentTask };
    }

    statusString() {
        const s = this.stats;
        let out = `Tasks: ${s.pending} pending, ${s.completed} done, ${s.failed} failed`;
        if (this._currentTask) {
            out += `\nCurrent: "${this._currentTask.description}" [${this._currentTask.progress}%]`;
        }
        if (this.pending.length > 0) {
            out += `\nNext: "${this.pending[0].description}"`;
        }
        return out;
    }

    async execute(agent, task, sendFeedback) {
        this._currentTask = task;
        task.status = TaskStatus.RUNNING;
        this.save();

        const maxStepRetries = 3;
        let allStepsSucceeded = true;

        for (let i = task.currentStep; i < task.steps.length; i++) {
            const step = task.steps[i];
            task.currentStep = i;

            if (!containsCommand(step)) {
                console.log(`[TaskQueue] Step ${i + 1}/${task.steps.length}: "${step}" (not a command, skipping)`);
                continue;
            }

            console.log(`[TaskQueue] Step ${i + 1}/${task.steps.length}: ${step}`);

            let stepSuccess = false;
            for (let retry = 0; retry < maxStepRetries && !stepSuccess; retry++) {
                try {
                    if (this.agent?.actions?.executing) {
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    if (task.status === TaskStatus.CANCELLED) break;

                    const result = await executeCommand(agent, step);
                    stepSuccess = result !== false && result !== null && result !== undefined;

                    if (sendFeedback && typeof result === 'string') {
                        const stripped = result.replace(/^Action output:\s*/i, '');
                        if (stripped.length > 0 && stripped.length < 200) {
                            this.agent?.history?.add('system', stripped);
                        }
                    }

                    if (stepSuccess) {
                        console.log(`[TaskQueue] Step ${i + 1} completed`);
                    }

                } catch (err) {
                    console.warn(`[TaskQueue] Step ${i + 1} failed (attempt ${retry + 1}/${maxStepRetries}): ${err.message}`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            if (!stepSuccess) {
                allStepsSucceeded = false;
                task.error = `Step ${i + 1} failed after ${maxStepRetries} retries: ${step}`;
                this.save();
                console.error(`[TaskQueue] Step ${i + 1}/${task.steps.length} failed: ${step}`);
                if (sendFeedback) {
                    this.agent?.history?.add('system', `[TaskQueue] Step ${i + 1}/${task.steps.length} failed: ${step}`);
                }
                break;
            }

            this.save();
        }

        task.status = allStepsSucceeded ? TaskStatus.COMPLETED : TaskStatus.FAILED;
        if (allStepsSucceeded) {
            task.completedAt = Date.now();
        }
        this._currentTask = null;
        this._processing = false;
        this.save();

        const msg = allStepsSucceeded ? `Completed: ${task.description}` : `Failed: ${task.description}${task.error ? ' (' + task.error + ')' : ''}`;
        console.log(`[TaskQueue] ${msg}`);
        if (sendFeedback) {
            this.agent?.history?.add('system', `[TaskQueue] ${msg}`);
        }

        return allStepsSucceeded;
    }

    async processNext(agent, sendFeedback = true) {
        if (this._processing) return false;
        if (this._currentTask) {
            if (!this._currentTask.isDone) return false;
            this._currentTask = null;
        }

        const next = this.pending[0];
        if (!next) return false;

        this._processing = true;
        try {
            return await this.execute(agent, next, sendFeedback);
        } finally {
            this._processing = false;
        }
    }

    resumeTasks(agent) {
        const resumed = this.tasks.filter(t => t.status === TaskStatus.PENDING);
        if (resumed.length > 0) {
            console.log(`[TaskQueue] ${resumed.length} tasks ready to resume`);
            return true;
        }
        return false;
    }
}
