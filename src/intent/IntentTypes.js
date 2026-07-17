export const Intent = {
    CHAT: 'chat',
    FOLLOW: 'follow',
    GIVE_ITEM: 'give_item',
    BUILD: 'build',
    MINE: 'mine',
    CRAFT: 'craft',
    FARM: 'farm',
    COLLECT: 'collect',
    FIGHT: 'fight',
    MOVE: 'move',
    INSPECT: 'inspect',
    SLEEP: 'sleep',
    STOP: 'stop',
    HELP: 'help',
    TASK_STATUS: 'task_status',
    UNKNOWN: 'unknown'
};

export const IntentConfidence = {
    HIGH: 0.9,
    MEDIUM: 0.7,
    LOW: 0.5,
    UNCERTAIN: 0.3
};

export class IntentResult {
    constructor(type, confidence, params = {}, raw = '') {
        this.type = type;
        this.confidence = confidence;
        this.params = params;
        this.raw = raw;
        this.timestamp = Date.now();
    }

    isReliable() {
        return this.confidence >= IntentConfidence.LOW;
    }

    needsLLM() {
        return this.type === Intent.UNKNOWN || this.confidence < IntentConfidence.LOW;
    }
}

export const TaskStatus = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

export class TaskItem {
    constructor(intent, description, steps = []) {
        this.id = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        this.intent = intent;
        this.description = description;
        this.steps = steps;
        this.status = TaskStatus.PENDING;
        this.currentStep = 0;
        this.createdAt = Date.now();
        this.completedAt = null;
        this.error = null;
        this.resumed = false;
        this.resumeCount = 0;
        this.metadata = {};
    }

    get isDone() {
        return this.status === TaskStatus.COMPLETED || this.status === TaskStatus.FAILED || this.status === TaskStatus.CANCELLED;
    }

    get progress() {
        if (this.steps.length === 0) return this.isDone ? 100 : 0;
        return Math.round((this.currentStep / this.steps.length) * 100);
    }

    toJSON() {
        return {
            id: this.id,
            intent: this.intent,
            description: this.description,
            steps: this.steps,
            status: this.status,
            currentStep: this.currentStep,
            createdAt: this.createdAt,
            completedAt: this.completedAt,
            error: this.error,
            resumed: this.resumed,
            resumeCount: this.resumeCount,
            metadata: this.metadata
        };
    }

    static fromJSON(data) {
        const task = new TaskItem(data.intent, data.description, data.steps);
        task.id = data.id;
        task.status = data.status;
        task.currentStep = data.currentStep;
        task.createdAt = data.createdAt;
        task.completedAt = data.completedAt;
        task.error = data.error;
        task.resumed = true;
        task.resumeCount = data.resumeCount || 0;
        task.metadata = data.metadata || {};
        return task;
    }
}
