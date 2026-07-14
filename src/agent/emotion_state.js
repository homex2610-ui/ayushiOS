export class EmotionState {
    constructor() {
        this.fear = 0.05;
        this.curiosity = 0.7;
        this.confidence = 0.5;
        this.energy = 1.0;
        this.stress = 0.05;
        this._lastTick = 0;
        this._lastDecay = Date.now();
    }

    getState() {
        return {
            fear: this.fear,
            curiosity: this.curiosity,
            confidence: this.confidence,
            energy: this.energy,
            stress: this.stress,
        };
    }

    get dominant() {
        const map = [
            { name: 'fear', value: this.fear },
            { name: 'curiosity', value: this.curiosity },
            { name: 'confident', value: this.confidence },
            { name: 'tired', value: 1 - this.energy },
            { name: 'stressed', value: this.stress },
        ];
        map.sort((a, b) => b.value - a.value);
        return map[0].name;
    }

    getDescription() {
        const parts = [];
        if (this.fear > 0.6) parts.push('scared');
        else if (this.fear > 0.3) parts.push('cautious');
        if (this.curiosity > 0.7) parts.push('curious');
        if (this.confidence > 0.7) parts.push('confident');
        else if (this.confidence < 0.3) parts.push('unsure');
        if (this.energy < 0.3) parts.push('tired');
        else if (this.energy > 0.8) parts.push('energetic');
        if (this.stress > 0.6) parts.push('overwhelmed');
        else if (this.stress > 0.3) parts.push('tense');
        if (parts.length === 0) parts.push('calm');
        return parts.join(', ');
    }

    applyEvent(event) {
        switch (event) {
            case 'damage':
                this.fear = Math.min(1, this.fear + 0.15);
                this.confidence = Math.max(0, this.confidence - 0.08);
                this.stress = Math.min(1, this.stress + 0.1);
                break;
            case 'death':
                this.fear = Math.min(1, this.fear + 0.3);
                this.confidence = Math.max(0, this.confidence - 0.2);
                this.stress = Math.min(1, this.stress + 0.15);
                break;
            case 'discovery':
                this.curiosity = Math.min(1, this.curiosity + 0.05);
                this.confidence = Math.min(1, this.confidence + 0.05);
                this.fear = Math.max(0, this.fear - 0.03);
                break;
            case 'success':
                this.confidence = Math.min(1, this.confidence + 0.08);
                this.stress = Math.max(0, this.stress - 0.05);
                break;
            case 'failure':
                this.confidence = Math.max(0, this.confidence - 0.1);
                this.stress = Math.min(1, this.stress + 0.08);
                break;
            case 'player_help':
                this.fear = Math.max(0, this.fear - 0.05);
                this.confidence = Math.min(1, this.confidence + 0.05);
                break;
            case 'night':
                this.fear = Math.min(1, this.fear + 0.1);
                break;
            case 'day':
                this.fear = Math.max(0, this.fear - 0.08);
                break;
            case 'idle':
                this.energy = Math.min(1, this.energy + 0.02);
                this.stress = Math.max(0, this.stress - 0.02);
                break;
            case 'move':
                this.energy = Math.max(0, this.energy - 0.01);
                break;
        }
        this._clamp();
    }

    tick(delta) {
        const now = Date.now();
        if (now - this._lastDecay < 60000) return;
        this._lastDecay = now;
        this.curiosity = Math.max(0.2, this.curiosity - 0.02);
        this.fear = Math.max(0.02, this.fear - 0.01);
        this.stress = Math.max(0.02, this.stress - 0.01);
        if (this.energy < 1) this.energy = Math.min(1, this.energy + 0.01);
    }

    _clamp() {
        this.fear = Math.max(0, Math.min(1, this.fear));
        this.curiosity = Math.max(0, Math.min(1, this.curiosity));
        this.confidence = Math.max(0, Math.min(1, this.confidence));
        this.energy = Math.max(0, Math.min(1, this.energy));
        this.stress = Math.max(0, Math.min(1, this.stress));
    }
}
