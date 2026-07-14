export class KnowledgeGraph {
    constructor() {
        this.nodes = {};
        this.edges = [];
    }

    ensureNode(id, { type = 'entity', label } = {}) {
        if (!this.nodes[id]) {
            this.nodes[id] = { id, type, label: label || id, firstSeen: Date.now() };
        }
        return this.nodes[id];
    }

    learnTriple(subject, relation, object) {
        this.ensureNode(subject);
        this.ensureNode(object);
        const existing = this.edges.find(e => e.subject === subject && e.relation === relation && e.object === object);
        if (existing) {
            existing.strength = Math.min(1, (existing.strength || 0.5) + 0.1);
            existing.lastSeen = Date.now();
            return;
        }
        this.edges.push({
            subject,
            relation,
            object,
            strength: 0.5,
            created: Date.now(),
            lastSeen: Date.now(),
        });
    }

    query(subject) {
        const out = this.edges.filter(e => e.subject === subject);
        const inn = this.edges.filter(e => e.object === subject);
        return {
            outgoing: out.map(e => ({ relation: e.relation, target: e.object, strength: e.strength })),
            incoming: inn.map(e => ({ relation: e.relation, source: e.subject, strength: e.strength })),
        };
    }

    queryRelation(subject, relation) {
        return this.edges
            .filter(e => e.subject === subject && e.relation === relation)
            .map(e => ({ target: e.object, strength: e.strength }));
    }

    getSummary() {
        if (this.edges.length === 0) return '';
        const sorted = [...this.edges].sort((a, b) => b.strength - a.strength);
        const top = sorted.slice(0, 8);
        return top.map(e => `${e.subject} ${e.relation} ${e.object}`).join('; ');
    }

    toJSON() {
        return { nodes: this.nodes, edges: this.edges };
    }

    load(data) {
        if (data?.nodes) this.nodes = data.nodes;
        if (data?.edges) this.edges = data.edges;
    }
}
