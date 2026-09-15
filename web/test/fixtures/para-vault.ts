/**
 * A vault shaped like the one this view is being built against, without its
 * content.
 *
 * The owner's real vault has 109 notes in PARA folders — 40 projects, 49
 * areas, 9 resources, 11 maps of content — and about 270 linked pairs. The
 * shape of that link graph is what decides whether clustering and the brain
 * form work, and a uniformly random graph has none of it: no project stars, no
 * maps of content that link everything, no orphans. So this reproduces the
 * structure — hub notes with their plans in a subfolder, a homelab area with
 * chains of related notes, a flat folder of service notes held together mainly
 * by two near-identical maps of content, runbooks pointing into the areas, a
 * handful of notes linked to nothing — with invented names. The repository is
 * public; the real titles are not.
 *
 * Deterministic: no randomness at all, so a failing test fails the same way on
 * every machine.
 */

import type { GraphData } from '../../src/api';

export interface FixtureVault {
  data: GraphData;
  /** Tags per node key (`owner` NUL `path`), the shape `buildGraph` accepts. */
  tags: Map<string, string[]>;
}

const OWNER = 'jb';

export function paraVault(): FixtureVault {
  const nodes: GraphData['nodes'] = [];
  const edges: GraphData['edges'] = [];
  const tags = new Map<string, string[]>();

  const note = (folder: string, name: string, noteTags: string[] = []): string => {
    const path = `${folder}/${name}.md`;
    nodes.push({ owner: OWNER, path, title: name, folder, links: 0 });
    if (noteTags.length > 0) tags.set(`${OWNER}\u0000${path}`, noteTags);
    return path;
  };
  const link = (from: string, to: string): void => {
    edges.push({ owner: OWNER, from, to });
  };

  // ---- 10_Projects: 40 ---------------------------------------------------
  const active = '10_Projects/11_Active';
  const projects: Array<{ hub: string; plans: string[] }> = [];
  const plansPer = [5, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0, 0, 0];
  const projectTags = [['ai', 'homelab'], ['ai'], [], ['ai'], ['homelab', 'monitoring'], ['ai'], [], [], [], ['docker', 'homelab'], ['docker', 'homelab'], ['ai'], []];
  plansPer.forEach((count, p) => {
    const name = `Project ${String.fromCharCode(65 + p)}`;
    const hub = note(active, name, projectTags[p]);
    const plans: string[] = [];
    for (let k = 0; k < count; k += 1) {
      const plan = note(`${active}/${name}`, `Plan ${k + 1} (${name})`, projectTags[p]);
      plans.push(plan);
      link(hub, plan);
      link(plan, hub);
      if (k > 0) link(plan, plans[k - 1]!);
    }
    projects.push({ hub, plans });
  });
  // Loose notes in the active folder that belong to no project star.
  const loose = [note(active, 'Idea one'), note(active, 'Idea two', ['ai']), note(active, 'Game one'), note(active, 'App one'), note(active, 'App two')];
  for (let i = 0; i < 2; i += 1) loose.push(note(active, `Side project ${i + 1}`, i === 0 ? ['ai'] : []));
  // Projects that reference each other: an agent family and an app family.
  link(projects[0]!.hub, projects[1]!.hub);
  link(projects[1]!.hub, projects[0]!.hub);
  link(projects[0]!.hub, projects[3]!.hub);
  link(projects[3]!.hub, projects[1]!.hub);
  link(projects[0]!.hub, projects[4]!.hub);
  link(projects[2]!.hub, loose[2]!);
  link(loose[2]!, loose[3]!);
  link(loose[3]!, loose[4]!);
  link(loose[4]!, loose[3]!);
  link(loose[5]!, projects[2]!.hub);
  link(loose[6]!, loose[1]!);
  const client = note('10_Projects/13_Kunden', 'Client backup');
  const done = [note('10_Projects/19_Done', 'Menu card', ['homelab']), note('10_Projects/19_Done', 'Gift site')];

  // ---- 20_Areas: 49 --------------------------------------------------------
  const lab = '20_Areas/21_Homelab';
  const labNames = ['Backup conflict', 'Backup gap', 'Backup', 'Printer', 'DNS', 'External surface', 'Hardware', 'WAN', 'VLANs', 'Switches', 'Cluster', 'Rule games', 'Reverse proxy', 'Smart home', 'Storage', 'Firewall', 'Rack display'];
  const labTags: Record<string, string[]> = { 'Backup conflict': ['backup', 'proxmox'], 'Backup gap': ['backup', 'proxmox'], Backup: ['backup', 'proxmox'], DNS: ['dns', 'networking'], WAN: ['networking'], VLANs: ['homelab', 'networking'], Switches: ['networking', 'unifi'], Firewall: ['networking', 'unifi'], 'Reverse proxy': ['networking'], Storage: ['proxmox'], Cluster: ['homelab', 'proxmox'], Hardware: ['homelab'], Printer: ['devices'], 'Smart home': ['devices'], 'Rack display': ['devices'] };
  const h = Object.fromEntries(labNames.map((n) => [n, note(lab, n, labTags[n] ?? [])])) as Record<string, string>;
  link(h['Backup conflict']!, h['Backup gap']!);
  link(h['Backup']!, h['Backup gap']!);
  link(h['Backup gap']!, h['Backup']!);
  link(h['Backup gap']!, h['Storage']!);
  link(h['Backup gap']!, h['Cluster']!);
  link(h['Storage']!, h['Backup']!);
  link(h['Cluster']!, h['Storage']!);
  link(h['Cluster']!, h['Backup']!);
  link(h['Cluster']!, h['Hardware']!);
  link(h['DNS']!, h['Hardware']!);
  link(h['External surface']!, h['Firewall']!);
  link(h['VLANs']!, h['Firewall']!);
  link(h['VLANs']!, h['DNS']!);
  link(h['VLANs']!, h['Reverse proxy']!);
  link(h['Reverse proxy']!, h['DNS']!);
  link(h['Reverse proxy']!, h['WAN']!);
  link(h['Smart home']!, h['Printer']!);

  const svc = '20_Areas/22_Selfhosted-Services';
  const services: string[] = [];
  for (let i = 0; i < 32; i += 1) {
    services.push(note(svc, `CT ${101 + i} service`, i % 4 === 0 ? ['docker', 'homelab'] : [`svc${i}`]));
  }
  // The service notes that belong to a project point back at it.
  link(services[23]!, projects[0]!.hub);
  link(projects[0]!.hub, services[23]!);
  link(services[17]!, projects[0]!.hub);
  link(services[17]!, services[23]!);
  link(services[24]!, projects[1]!.hub);
  link(projects[1]!.hub, services[24]!);
  link(services[30]!, projects[2]!.hub);
  link(projects[2]!.hub, services[30]!);
  link(projects[4]!.hub, services[15]!);
  link(services[15]!, projects[4]!.hub);
  link(services[15]!, services[28]!);
  link(services[28]!, services[26]!);
  link(projects[9]!.hub, services[21]!);
  link(services[21]!, projects[9]!.hub);
  link(projects[10]!.hub, services[22]!);
  link(services[22]!, projects[10]!.hub);
  link(services[27]!, done[0]!);
  link(done[0]!, services[27]!);
  link(services[27]!, services[0]!);
  link(services[27]!, h['Firewall']!);
  link(services[29]!, services[0]!);
  link(services[29]!, h['Backup gap']!);
  link(h['Backup gap']!, services[23]!);
  link(h['Backup gap']!, services[24]!);
  link(h['Backup gap']!, services[18]!);
  link(h['Backup gap']!, services[3]!);
  link(services[15]!, h['Backup gap']!);
  link(services[23]!, h['Firewall']!);
  link(services[23]!, services[18]!);
  link(services[23]!, services[19]!);
  link(services[9]!, h['DNS']!);
  link(services[9]!, h['Switches']!);
  link(h['Rack display']!, services[15]!);
  link(services[16]!, h['Smart home']!);

  // ---- 30_Resources: 9 -----------------------------------------------------
  const tech = '30_Resources/31_Tech-Knowledge';
  const runbooks = ['Runbook restore', 'Runbook recovery', 'Runbook deploy', 'Runbook firewall', 'Runbook agent access', 'Runbook note restore'].map((n) =>
    note(tech, n, ['runbook']),
  );
  const cli = note(tech, 'CLI delegation', ['ai']);
  const exportNote = note(tech, 'Document export');
  const reference = note('30_Resources/32_Reference-Docs', 'Retired stream', ['homelab']);
  link(runbooks[0]!, h['Backup']!);
  link(runbooks[0]!, h['Storage']!);
  link(runbooks[1]!, h['Cluster']!);
  link(runbooks[1]!, h['Backup']!);
  link(runbooks[2]!, h['Reverse proxy']!);
  link(runbooks[2]!, h['Firewall']!);
  link(runbooks[3]!, h['Firewall']!);
  link(runbooks[3]!, h['Reverse proxy']!);
  link(runbooks[4]!, services[30]!);
  link(runbooks[4]!, services[23]!);
  link(runbooks[4]!, services[17]!);
  link(runbooks[5]!, services[30]!);
  link(services[30]!, runbooks[4]!);
  link(services[30]!, runbooks[5]!);
  link(cli, loose[0]!);

  // ---- 40_MOCs: 11 ---------------------------------------------------------
  const mocs = '40_MOCs';
  const home = note(mocs, 'MOC Home', ['navigation']);
  const mocLab = note(mocs, 'MOC Homelab', ['homelab']);
  const mocProjects = note(mocs, 'MOC Projects', ['navigation']);
  const mocRunbooks = note(mocs, 'MOC Runbooks', ['homelab']);
  const mocServices = note(mocs, 'MOC Services', ['homelab']);
  const mocServicesCopy = note(mocs, 'MOC Services (conflict)', ['homelab']);
  const rules = [note(mocs, 'Rules writing', ['ai', 'governance']), note(mocs, 'Rules working', ['ai', 'governance']), note(mocs, 'Rules brain', ['ai', 'governance']), note(mocs, 'Rules agent', ['ai', 'governance'])];
  const registry = note(mocs, 'Tag registry', ['governance']);

  for (const target of [mocProjects, registry, rules[2]!, rules[3]!]) link(home, target);
  for (const n of labNames.filter((n) => !['Backup conflict', 'Backup gap', 'Printer', 'Rule games', 'Rack display'].includes(n))) link(mocLab, h[n]!);
  for (const target of [projects[0]!.hub, services[23]!, services[24]!, services[21]!, services[15]!, services[27]!, services[28]!, reference, home, mocLab, mocServices, rules[3]!, services[22]!, services[17]!]) link(mocProjects, target);
  for (const target of [...runbooks, h['Firewall']!, h['Cluster']!, h['Backup']!, h['Storage']!, h['Backup gap']!, services[0]!, services[30]!, services[24]!, services[18]!]) link(mocRunbooks, target);
  for (const moc of [mocServices, mocServicesCopy]) {
    for (let i = 0; i < 32; i += 1) if (i !== 20 && i !== 25) link(moc, services[i]!);
    link(moc, h['Reverse proxy']!);
    link(moc, h['External surface']!);
    link(moc, h['Smart home']!);
    link(moc, h['Rule games']!);
    link(moc, mocLab);
    link(moc, mocRunbooks);
    link(moc, reference);
    link(moc, mocProjects);
  }
  link(rules[0]!, rules[2]!);
  link(rules[0]!, services[19]!);
  link(rules[1]!, rules[2]!);
  link(rules[1]!, rules[3]!);
  link(rules[2]!, services[23]!);
  link(rules[2]!, services[17]!);
  link(rules[2]!, rules[0]!);
  link(rules[2]!, services[19]!);
  link(rules[2]!, registry);
  link(rules[2]!, services[18]!);
  link(rules[2]!, runbooks[5]!);
  link(rules[2]!, h['Backup gap']!);
  link(rules[2]!, rules[3]!);
  link(rules[2]!, home);
  link(rules[3]!, services[30]!);
  link(rules[3]!, services[19]!);
  link(rules[3]!, rules[2]!);
  link(rules[3]!, registry);
  link(projects[0]!.hub, rules[3]!);
  link(projects[0]!.hub, rules[2]!);
  link(projects[0]!.hub, services[30]!);
  link(projects[0]!.hub, h['Rule games']!);
  link(projects[2]!.hub, services[19]!);
  link(projects[2]!.hub, mocProjects);

  // The server counts resolved links in both directions, once per pair and
  // direction; do the same so `links` means what it means in production.
  const seen = new Set<string>();
  const unique = edges.filter((e) => {
    const k = `${e.from}\u0000${e.to}`;
    if (e.from === e.to || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const degree = new Map<string, number>();
  for (const e of unique) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  for (const n of nodes) n.links = degree.get(n.path) ?? 0;
  // The server lists by path.
  nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  void client;
  void exportNote;
  return { data: { nodes, edges: unique }, tags };
}

/** The same vault listed in a different order, as a different server reply might. */
export function shuffled(data: GraphData, seed = 7): GraphData {
  let s = seed;
  const rnd = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const mix = <T>(list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { nodes: mix(data.nodes).map((n) => ({ ...n })), edges: mix(data.edges) };
}
