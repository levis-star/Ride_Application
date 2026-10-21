"use client";

import { useCallback, useEffect, useState } from "react";
import { LANDMARK_CATEGORIES } from "@rukwaride/shared";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface Landmark {
  id: string;
  name: string;
  aliasNames: string[];
  category: string;
  lat: number;
  lng: number;
  source: string;
  verified: boolean;
  verifiedAt: string | null;
}

interface DupGroup {
  name: string;
  count: number;
  items: Landmark[];
}

const BLANK = { name: "", category: "other", lat: "", lng: "", aliasNames: "" };

/**
 * Landmark curation for staff with local knowledge.
 *
 * Our places come from OpenStreetMap, which around Sumbawanga labels ATMs as
 * bank branches and maps some places twice — a passenger asking for "NMB Bank"
 * could be sent to a cash machine. Nothing here is guessed from OSM: a place
 * only becomes "verified" when a person confirms it, and verified/edited
 * records are never overwritten by the next import.
 */
export default function LandmarksPage() {
  const [rows, setRows] = useState<Landmark[]>([]);
  const [dups, setDups] = useState<DupGroup[]>([]);
  const [q, setQ] = useState("");
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);
  const [editing, setEditing] = useState<Landmark | null>(null);
  const [draft, setDraft] = useState(BLANK);
  const [creating, setCreating] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  function toast(m: string) {
    setFlash(m);
    setTimeout(() => setFlash(null), 3000);
  }

  const refresh = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (unverifiedOnly) params.set("unverified", "true");
    void api<Landmark[]>("GET", `/admin/landmarks?${params}`).then(setRows).catch(() => {});
    void api<DupGroup[]>("GET", "/admin/landmarks/duplicates").then(setDups).catch(() => {});
  }, [q, unverifiedOnly]);

  useEffect(refresh, [refresh]);

  function startEdit(l: Landmark) {
    setCreating(false);
    setEditing(l);
    setDraft({
      name: l.name,
      category: l.category,
      lat: String(l.lat),
      lng: String(l.lng),
      aliasNames: l.aliasNames.join(", "),
    });
  }

  function startCreate() {
    setEditing(null);
    setCreating(true);
    setDraft(BLANK);
  }

  function draftBody() {
    return {
      name: draft.name.trim(),
      category: draft.category,
      lat: Number(draft.lat),
      lng: Number(draft.lng),
      aliasNames: draft.aliasNames
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    };
  }

  async function save() {
    const body = draftBody();
    if (!body.name || Number.isNaN(body.lat) || Number.isNaN(body.lng)) {
      toast("Name and valid coordinates are required");
      return;
    }
    try {
      if (creating) await api("POST", "/admin/landmarks", body);
      else if (editing) await api("PATCH", `/admin/landmarks/${editing.id}`, body);
      setEditing(null);
      setCreating(false);
      refresh();
      toast("Saved");
    } catch {
      toast("Save failed");
    }
  }

  async function verify(l: Landmark) {
    await api("PATCH", `/admin/landmarks/${l.id}`, { verified: !l.verified }).catch(() => {});
    refresh();
    toast(l.verified ? "Marked unverified" : "Verified");
  }

  async function remove(l: Landmark) {
    if (!window.confirm(`Delete "${l.name}"? Trips keep their coordinates.`)) return;
    await api("DELETE", `/admin/landmarks/${l.id}`).catch(() => {});
    refresh();
    toast("Deleted");
  }

  async function merge(from: Landmark, group: Landmark[]) {
    const others = group.filter((g) => g.id !== from.id);
    const target = window.prompt(
      `Merge "${from.name}" (${from.lat}, ${from.lng}) into which one?\n\n` +
        others.map((o, i) => `${i + 1}. ${o.lat}, ${o.lng}${o.verified ? " ✓verified" : ""}`).join("\n") +
        "\n\nEnter a number:",
    );
    const idx = Number(target) - 1;
    if (!others[idx]) return;
    await api("POST", `/admin/landmarks/${from.id}/merge`, { intoId: others[idx]!.id }).catch(() => {});
    refresh();
    toast("Merged");
  }

  return (
    <StaffShell>
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-bold">Landmarks</h2>
          <input
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            placeholder="Search name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="flex items-center gap-1 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={unverifiedOnly}
              onChange={(e) => setUnverifiedOnly(e.target.checked)}
            />
            Unverified only
          </label>
          <button
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
            onClick={startCreate}
          >
            + Add landmark
          </button>
        </div>

        <p className="mb-3 text-xs text-gray-500">
          Places are imported from OpenStreetMap and are <strong>not</strong> verified until someone
          confirms them here. OSM mislabels some ATMs as bank branches and maps a few places twice —
          fix the name, drop a wrong one, or merge duplicates. Verified and edited places are never
          overwritten by the next import.
        </p>

        {(creating || editing) && (
          <div className="mb-4 rounded-xl border border-brand-200 bg-brand-50 p-3">
            <div className="mb-2 text-sm font-semibold">
              {creating ? "New landmark" : `Editing "${editing?.name}"`}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                placeholder="Name (e.g. NMB Bank — Tawi la Sumbawanga)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <select
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              >
                {LANDMARK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                placeholder="Latitude (e.g. -7.9654)"
                value={draft.lat}
                onChange={(e) => setDraft({ ...draft, lat: e.target.value })}
              />
              <input
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                placeholder="Longitude (e.g. 31.6144)"
                value={draft.lng}
                onChange={(e) => setDraft({ ...draft, lng: e.target.value })}
              />
              <input
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm sm:col-span-2"
                placeholder="Other names people search, comma separated (e.g. NMB, Benki ya NMB)"
                value={draft.aliasNames}
                onChange={(e) => setDraft({ ...draft, aliasNames: e.target.value })}
              />
            </div>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
                onClick={() => void save()}
              >
                Save
              </button>
              <button
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                onClick={() => {
                  setEditing(null);
                  setCreating(false);
                }}
              >
                Cancel
              </button>
              {editing && (
                <a
                  className="ml-auto self-center text-sm text-brand-700 underline"
                  href={`https://www.google.com/maps/search/?api=1&query=${draft.lat},${draft.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Check these coordinates on Google Maps ↗
                </a>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="py-1">Name</th>
                <th>Category</th>
                <th>Coordinates</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="border-t border-gray-100">
                  <td className="py-1.5">
                    {l.verified && <span title="Verified by staff">✓ </span>}
                    {l.name}
                    {l.aliasNames.length > 0 && (
                      <span className="text-xs text-gray-400"> ({l.aliasNames.join(", ")})</span>
                    )}
                  </td>
                  <td className="text-gray-600">{l.category}</td>
                  <td className="font-mono text-xs text-gray-500">
                    {l.lat.toFixed(5)}, {l.lng.toFixed(5)}
                  </td>
                  <td>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        l.source === "STAFF" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {l.source === "STAFF" ? "staff" : "osm"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button className="px-1.5 text-brand-700 underline" onClick={() => startEdit(l)}>
                      Edit
                    </button>
                    <button className="px-1.5 text-brand-700 underline" onClick={() => void verify(l)}>
                      {l.verified ? "Unverify" : "Verify"}
                    </button>
                    <button className="px-1.5 text-red-600 underline" onClick={() => void remove(l)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="py-3 text-gray-500" colSpan={5}>
                    No landmarks match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {dups.length > 0 && (
        <Card className="mt-4">
          <h2 className="mb-1 font-bold">Possible duplicates</h2>
          <p className="mb-3 text-xs text-gray-500">
            Same name, more than one location. Some are genuinely different branches; others are the
            same place mapped twice, or an ATM named after its bank. Merge or delete the wrong ones.
          </p>
          {dups.map((g) => (
            <div key={g.name} className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2">
              <div className="text-sm font-semibold">
                {g.items[0]?.name} — {g.count} locations
              </div>
              <ul className="mt-1 space-y-1">
                {g.items.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-gray-600">
                      {l.lat.toFixed(5)}, {l.lng.toFixed(5)}
                    </span>
                    {l.verified && <span className="text-green-700">✓ verified</span>}
                    <a
                      className="text-brand-700 underline"
                      href={`https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view ↗
                    </a>
                    <button className="text-brand-700 underline" onClick={() => startEdit(l)}>
                      edit
                    </button>
                    <button className="text-brand-700 underline" onClick={() => void merge(l, g.items)}>
                      merge into…
                    </button>
                    <button className="text-red-600 underline" onClick={() => void remove(l)}>
                      delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      )}

      {flash && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white">
          {flash}
        </div>
      )}
    </StaffShell>
  );
}
