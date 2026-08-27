const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 30000;
        this._lastPromptTime = 0;
    }

    start(prompt) {
        if (!prompt) {
            if (!this.prompt) return 'No prompt specified.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() { return this.state === ACTIVE; }
    isStopped() { return this.state === STOPPED; }
    isPaused() { return this.state === PAUSED; }

    async handleLoad(prompt, state) {
        if (state == undefined) state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) await this.start(prompt);
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) return;
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 2;
        while (!this.interrupt && this.state === ACTIVE) {
            if (this.agent._messageQueue.length > 0) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            if (this.agent.actions.executing) {
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
            const msg = `Your goal: ${this.prompt}. Do what it takes. Use a command.`;
            let used_command = await this.agent.handleMessage('system', msg, -1);
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    this.state = STOPPED;
                    break;
                }
            } else {
                no_command_count = 0;
            }
            await new Promise(r => setTimeout(r, this.cooldown));
        }
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // A raw `interrupt = true` poke with no loop running (e.g. from
        // respondFunc between cycles) would block auto-restart forever.
        if (this.interrupt && !this.loop_active) this.interrupt = false;
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle() && this.agent._messageQueue.length === 0)
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                this.startLoop();
                this.idle_time = 0;
            }
        } else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        if (this.interrupt) return;
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action) await this.agent.actions.stop();
        // stopLoop early-returns when interrupt is already set, so wait out
        // any running loop here and clear the flag ourselves — a sticky
        // interrupt would block future starts via update().
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
        this.state = PAUSED;
    }

    pushGoal(goal) {
        if (!goal) return;
        this.prompt = goal;
        if (this.state !== ACTIVE) {
            this.state = ACTIVE;
            this.startLoop();
        }
    }

    shouldInterrupt(is_self_prompt) {
        return is_self_prompt && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        if (!is_self_prompt && is_action) {
            this.stopLoop();
        }
    }
}
