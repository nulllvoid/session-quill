import React, { memo, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Header from '@cloudscape-design/components/header';
import Badge from '@cloudscape-design/components/badge';
import Icon from '@cloudscape-design/components/icon';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { applyMode } from '@cloudscape-design/global-styles';
import { NAV_ITEMS, OWNER_ONLY_VIEWS } from '../views/header.js';
import { viewCounts } from '../components.js';
import { needsYouCount } from '../lib/runs.js';

// These islands retain ownership of their DOM. React never reconciles their children.
// Moving the original nodes preserves delegated events, modal focus and polling state.
const Island = memo(function Island({ node, className }) {
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current.appendChild(node); }, [node]);
  return <div ref={ref} className={className} />;
});

const descriptions = {
  work: 'Your outcomes, next steps, and decisions.',
  runs: 'Follow your agents. Review what needs you.',
  updates: 'Turn recorded work into a readable daily brief.',
  memory: 'The knowledge your next session starts with.',
  sessions: 'Pick up the thread. Keep the context.',
  deployments: 'Track what shipped and what still needs evidence.',
  today: 'Changes, decisions, and activity across your workspace.',
};
const icons = { work: 'check', runs: 'play', updates: 'calendar', sessions: 'command-prompt', today: 'history', deployments: 'upload', memory: 'folder' };
const navigate = (view) => document.dispatchEvent(new CustomEvent('quill:navigate', { detail: { view } }));

function Shell({ state, nodes }) {
  const { snapshot, view = 'work', filters = {}, online = true, collapsed = false, memory, now } = state;
  const counts = snapshot ? viewCounts(snapshot, filters) : {};
  const needs = snapshot && now ? needsYouCount(snapshot, now, memory) : 0;
  const label = NAV_ITEMS.find(([id]) => id === view)?.[1] || 'Work';
  const visibleItems = NAV_ITEMS.filter(([id]) => !snapshot?.meta.exported_at || !OWNER_ONLY_VIEWS.has(id));
  const link = ([id, text]) => ({
    type: 'link', text, href: `#view=${id}`,
    icon: <Icon name={icons[id]} />,
    info: id === 'runs' && (counts.runs || needs) ? <span className="platform-run-count"><Badge>{counts.runs || 0}</Badge>{needs > 0 && <span className="attention-dot" aria-hidden="true" />}</span> : undefined,
  });
  useLayoutEffect(() => {
    for (const [id, text, , shortcut] of visibleItems) {
      const anchor = document.querySelector(`#sidebar a[href="#view=${id}"]`);
      if (!anchor) continue;
      anchor.id = `tab-${id}`;
      anchor.setAttribute('aria-keyshortcuts', shortcut);
      anchor.setAttribute('aria-label', id === 'runs' ? `${text}, ${counts.runs || 0} live${needs ? `, ${needs} need you` : ''}` : text);
    }
  });
  const follow = (event) => {
    event.preventDefault();
    const next = new URLSearchParams(event.detail.href.slice(1)).get('view');
    if (NAV_ITEMS.some(([id]) => id === next)) navigate(next);
  };
  return <>
    <div id="platform-topbar" className="platform-topbar">
      <a className="platform-brand" href="#view=work" onClick={(e) => { e.preventDefault(); navigate('work'); }}>
        <img src="/ui/assets/brand/quill-mark-dark.svg" width="32" height="32" alt="" />
        <span>Quill<span className="platform-brand-note">your work, in sync</span></span>
      </a>
      <Island node={nodes.header} className="platform-header-island" />
    </div>
    <AppLayout
      headerSelector="#platform-topbar" toolsHide contentType="default"
      navigationWidth={224} maxContentWidth={1600}
      navigationOpen={!collapsed}
      onNavigationChange={({ detail }) => document.dispatchEvent(new CustomEvent('quill:navigation', { detail: { collapsed: !detail.open } }))}
      ariaLabels={{ navigation: 'Workspace navigation', navigationToggle: 'Toggle navigation', navigationClose: 'Close navigation' }}
      navigation={<div id="sidebar" className="platform-navigation">
        <div className="platform-workspace"><span className="workspace-avatar">Q</span><div><strong>{snapshot?.meta.store_name || 'Local workspace'}</strong><span>Personal workspace</span></div></div>
        <SideNavigation activeHref={`#view=${view}`} onFollow={follow} items={[
          { type: 'section-group', title: 'Workspace', items: visibleItems.filter(item => item[4] === 'work').map(link) },
          { type: 'section-group', title: 'Insights', items: visibleItems.filter(item => item[4] === 'track').map(link) },
        ]} />
        <div className="platform-nav-footer"><StatusIndicator type={!online ? 'error' : !snapshot ? 'loading' : 'success'}>{!online ? 'Worker offline' : !snapshot ? 'Connecting to worker' : 'Worker connected'}</StatusIndicator><p>Local workspace · Private by default</p><kbd>1–8</kbd> <span>switch views</span></div>
      </div>}
      breadcrumbs={<BreadcrumbGroup ariaLabel="Breadcrumbs" onFollow={follow} items={[{ text: 'Workspace', href: '#view=work' }, { text: label, href: `#view=${view}` }]} />}
      content={<div className="platform-content">
        <div className="platform-heading"><Header variant="h1" description={descriptions[view]}><span id="platform-page-title">{label}</span></Header></div>
        <Island node={nodes.filters} />
        <Island node={nodes.layout} />
      </div>}
    />
  </>;
}

// The static exporter removes this entry point. The live app also works without it.
const nodes = {
  header: document.getElementById('header'), filters: document.getElementById('filters'),
  layout: document.querySelector('.layout'),
};
const rootNode = document.createElement('div');
rootNode.id = 'platform-root';
document.body.insertBefore(rootNode, document.querySelector('.shell'));
const root = createRoot(rootNode);
let initialTheme = 'light';
let initialCollapsed = window.innerWidth < 900;
try {
  initialTheme = localStorage.getItem('st-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (window.innerWidth >= 900) initialCollapsed = localStorage.getItem('st-sidebar-collapsed') === 'true';
} catch { /* use system defaults */ }
document.documentElement.dataset.theme = initialTheme;
applyMode(initialTheme);
// Remove only the legacy navigation; content islands move into AppLayout on mount.
document.getElementById('sidebar').remove();
document.body.dataset.platform = 'cloudscape';
const initialView = new URLSearchParams(location.hash.slice(1)).get('view');
flushSync(() => root.render(<Shell state={{ view: NAV_ITEMS.some(([id]) => id === initialView) ? initialView : 'work', collapsed: initialCollapsed }} nodes={nodes} />));
document.querySelector('.shell').remove();
window.quillShell = {
  update(state) {
    applyMode(state.theme);
    flushSync(() => root.render(<Shell state={state} nodes={nodes} />));
  },
  setModal(modal) {
    for (const element of document.querySelectorAll('.platform-brand, .platform-heading, [aria-label="Breadcrumbs"], [aria-label="Workspace navigation"], button[aria-label="Toggle navigation"]')) element.inert = modal;
  },
};
