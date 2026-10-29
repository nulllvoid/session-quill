import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkTree } from '../../ui/lib/work.js';
import { renderWork } from '../../ui/views/work.js';
import { snapshot, ticket } from './fixtures.js';
const data = () => snapshot({ tickets: [ticket(1, { work_rollup: { required_total: 2, required_completed: 1, required_remaining: 1 } }), ticket(2, { parent_id: ticket(1).id, blocks_parent: true }), ticket(3, { parent_id: ticket(2).id, blocks_parent: true, title: 'deep needle' }), ticket(4, { parent_id: ticket(1).id, blocks_parent: true, status: 'done' })] });
test('search includes every ancestor, counts only matches, and does not change full rollups', () => {
 const s = data(), tree = buildWorkTree(s, { q: 'needle' }, { lens: 'all' });
 assert.deepEqual([...tree.matches], [ticket(3).id]);
 assert.equal(tree.visible.size, 3);
 assert.equal(tree.context.has(ticket(1).id), true);
 const html = renderWork(s, { q: 'needle' }, { lens: 'all' });
 assert.match(html, /1 matching task in 1 outcome/);
 assert.match(html, /1 of 2 required subtasks completed/);
 assert.match(html, /deep needle/);
 assert.doesNotMatch(html, /role="tree/);
});
test('a matching parent does not make its descendants search matches', () => {
 const tree = buildWorkTree(data(), { q: 'Ticket 1' }, { lens: 'all' });
 assert.equal(tree.visible.size, 1);
});
test('cycles and missing parents remain visible exactly once without mutating input', () => {
 const s = snapshot({ tickets: [ticket(1, { parent_id: ticket(2).id }), ticket(2, { parent_id: ticket(1).id }), ticket(3, { parent_id: 'absent' })] });
 const before = JSON.stringify(s);
 const tree = buildWorkTree(s, {}, { lens: 'all' });
 assert.equal(tree.roots.length, 2);
 assert.equal(tree.invalid.size, 2);
 const html = renderWork(s, {}, { lens: 'all', expanded: new Set(s.tickets.map(t => t.id)) });
 for (const t of s.tickets) assert.equal(html.split(`data-work-row="${t.id}"`).length - 1, 1);
 assert.equal(JSON.stringify(s), before);
});
test('Open preserves done ancestors with actionable descendants and required conflicts', () => {
 const s = data(); s.tickets[0].status = 'done';
 const tree = buildWorkTree(s, {}, {});
 assert.ok(tree.visible.has(s.tickets[0].id));
 assert.ok(tree.context.has(s.tickets[0].id));
});
test('completed and independent children use separate disclosures, selected parents do not select children', () => {
 const s = data(); s.tickets.push(ticket(5, { parent_id: ticket(1).id, blocks_parent: false }));
 const html = renderWork(s, {}, { lens: 'all', expanded: new Set([ticket(1).id]), checked: new Set([ticket(1).id]) });
 assert.match(html, /Completed \(1\)/); assert.match(html, /Related follow-ups \(1\)/);
 assert.equal((html.match(/ checked/g) || []).length, 1);
});
test('status and priority values combine with OR within each dimension and AND between dimensions', () => {
 const s=snapshot({tickets:[ticket(1,{status:'todo',priority:'P1'}),ticket(2,{status:'active',priority:'P2'}),ticket(3,{status:'done',priority:'P1'})]});
 const tree=buildWorkTree(s,{status:'todo,active',priority:'P1,P2'},{lens:'all'});
 assert.deepEqual([...tree.matches],[ticket(1).id,ticket(2).id]);
});
test('collapsed branches do not render thousands of descendants; expanded children are paged', () => {
 const parent=ticket(1), s=snapshot({tickets:[parent,...Array.from({length:1000},(_,i)=>ticket(i+2,{parent_id:parent.id,blocks_parent:true}))]});
 const collapsed=renderWork(s,{}, {lens:'all'}); assert.equal((collapsed.match(/data-work-row=/g)||[]).length,1);
 const expanded=renderWork(s,{}, {lens:'all',expanded:new Set([parent.id])}); assert.equal((expanded.match(/data-work-row=/g)||[]).length,101); assert.match(expanded,/Show 100 more subtasks/);
});
test('Work and Runs reuse task attention identities and a starting retry does not erase failure', async () => {
 const {runTabs,needsYou}=await import('../../ui/lib/runs.js');
 const s=snapshot({tickets:[ticket(1,{status:'blocked',blocker:'Waiting on access',work_rollup:{attention_count:1,closure_state:'not-ready',reasons:[{code:'blocked',text:'Waiting on access'}]}})],handoffs:[{id:'failed',ticket_id:ticket(1).id,state:'failed',intent:'auto',requested_at:'2026-01-01T00:00:00Z'},{id:'retry',ticket_id:ticket(1).id,state:'running',requested_at:'2026-10-30T00:00:00Z',retry_of:'failed'}]});
 assert.equal(needsYou(s,s.handoffs[0],'2026-10-30T12:00:00Z'),true);
 const attention=runTabs(s,{},'2026-10-30T12:00:00Z').needs;
 assert.ok(attention.some(i=>i.kind==='work'&&i.ticket.id===ticket(1).id));
 assert.ok(buildWorkTree(s,{}, {lens:'attention',now:'2026-10-30T12:00:00Z'}).matches.has(ticket(1).id));
});
test('a cancelled retry followed by successful evidence resolves an earlier failure', async () => {
 const {needsYou}=await import('../../ui/lib/runs.js'); const t=ticket(1), fail={id:'failure',ticket_id:t.id,state:'failed',intent:'auto',requested_at:'2026-01-01T00:00:00Z'};
 const s=snapshot({tickets:[t],handoffs:[fail,{id:'cancelled',ticket_id:t.id,state:'cancelled',requested_at:'2026-01-02T00:00:00Z'},{id:'success',ticket_id:t.id,state:'done',requested_at:'2026-01-03T00:00:00Z'}]});
 assert.equal(needsYou(s,fail,'2026-10-30T00:00:00Z'),false);
});
