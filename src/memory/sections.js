// The sections of the memory projections (spec §6.1), in their spec order, and how a learning's
// free-text section is mapped onto them. Filing stores the canonical id; the projections map again
// at render time, so an entry with any older or hand-typed section still lands somewhere sensible.

export const REPO_SECTIONS = [
  { id: 'build-test', title: 'Build & test', match: /build|test|\bci\b|lint|compil|install|depend|package/i },
  { id: 'conventions', title: 'Conventions', match: /convention|style|naming|format|pattern|architect|structure/i },
  { id: 'docs', title: 'Docs & runbooks', match: /doc|runbook|readme|guide|pointer|wiki/i },
  { id: 'environments', title: 'Environments & deploy', match: /env|deploy|argo|k8s|kube|namespace|kibana|prod|staging|\bstg\b|cluster|infra|release/i },
  { id: 'procedures', title: 'Procedures', match: /procedure|how[ -]?to|steps?\b|workflow|process/i },
  { id: 'pitfalls', title: 'Pitfalls', match: /pitfall|gotcha|caveat|trap|warning|flak|bug|issue|problem/i },
];

export const MACHINE_SECTIONS = [
  { id: 'tools', title: 'Tools', match: /tool|\bclis?\b|binar|version|install/i },
  { id: 'connectors', title: 'Connectors & MCP', match: /connector|mcp|server|integration|jira|slack|kibana|argo/i },
  { id: 'how', title: 'How', match: /how|procedure|usage|steps?\b/i },
  { id: 'where', title: 'Where', match: /where|location|path|dir|folder/i },
  { id: 'pitfalls', title: 'Pitfalls', match: /pitfall|gotcha|caveat|trap|warning|flak|bug|issue|problem/i },
];

export const TASK_SECTIONS = [{ id: 'lessons', title: 'Lessons', match: /./ }];

// Neither a spec section nor mappable by kind; listed after the spec sections.
export const OTHER = { id: 'other', title: 'Other' };

// Keyword checks run most specific first, so "Test pitfalls" is a pitfall and "Deploy steps" an
// environment fact.
const REPO_MATCH_ORDER = ['pitfalls', 'environments', 'build-test', 'docs', 'procedures', 'conventions'];
const MACHINE_MATCH_ORDER = ['pitfalls', 'connectors', 'tools', 'where', 'how'];
const REPO_BY_KIND = { pitfall: 'pitfalls', procedure: 'procedures', pointer: 'docs', tool: 'build-test' };
const MACHINE_BY_KIND = { pitfall: 'pitfalls', procedure: 'how', pointer: 'where', tool: 'tools' };

export function sectionsFor(scope) {
  return scope === 'machine' ? MACHINE_SECTIONS : scope === 'task' ? TASK_SECTIONS : REPO_SECTIONS;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The canonical section id for a learning's scope, free-text section and kind. */
export function canonicalSection(scope, section, kind) {
  if (scope === 'task') return 'lessons';
  const list = sectionsFor(scope);
  const text = typeof section === 'string' ? section.trim() : '';
  if (text) {
    const exact = list.find((s) => squash(s.id) === squash(text) || squash(s.title) === squash(text));
    if (exact) return exact.id;
    for (const id of scope === 'machine' ? MACHINE_MATCH_ORDER : REPO_MATCH_ORDER) {
      if (list.find((s) => s.id === id).match.test(text)) return id;
    }
  }
  const byKind = (scope === 'machine' ? MACHINE_BY_KIND : REPO_BY_KIND)[kind];
  return byKind ?? OTHER.id;
}
