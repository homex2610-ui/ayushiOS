export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this._lastExecutedLabel = '';
        this._lastExecutedTime = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) {
            this.resume_func = actionFn;
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        try {
            if (this.executing) {
                const sameAction = actionLabel === this.currentActionLabel || actionLabel === this._lastExecutedLabel;
                const now = Date.now();
                if (sameAction && now - this._lastExecutedTime < 5000) {
                    console.warn(`[Action] Skipping duplicate action "${actionLabel}" (executed ${((now - this._lastExecutedTime)/1000).toFixed(1)}s ago)`);
                    return { success: false, message: `Duplicate action "${actionLabel}" skipped.`, interrupted: false, timedout: false };
                }
            }

            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                } else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    this.cancelResume();
                }
                if (this.recent_action_counter > 5) {
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();

            if (this.executing) {
                await this.stop();
            }

            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // Acquire BT mutex — BT will yield while chat-driven action runs
            const agent = this.agent;
            agent._btMutex = 'chat';
            if (agent.btCurrentTask) {
                agent.btCurrentTask.reset();
                agent.btCurrentTask = null;
            }
            agent.requestInterrupt();
            // Clear the interrupt flag immediately — it was only meant to stop previous actions
            this.agent.bot.interrupt_code = false;

            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            const actionResult = await actionFn();

            agent._btMutex = null;
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            this._lastExecutedLabel = actionLabel;
            this._lastExecutedTime = Date.now();

            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            return { success: true, message: output, actionResult, interrupted, timedout };
        } catch (err) {
            this.agent._btMutex = null;
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            await this.stop();

            let message = this.getBotOutputSummary() +
                'Error: ' + (err.message || String(err));

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n` +
                `First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n${output.substring(output.length - MAX_OUT / 2)}`;
        } else if (output.length > 0) {
            output = 'Action output:\n' + output;
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            this.timedout = true;
            try {
                await this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
                await this.stop();
            } catch (err) {
                console.error('[Action] Timeout handler error:', err.message);
            }
        }, TIMEOUT_MINS * 60 * 1000);
    }

}
