// Region-pack picker: a header chip (styled like the tier chip) for
// switching the active map/routing region (e.g. Sandia <-> Chamonix). A
// native <select> rather than a toggle button — unlike the 2-state tier
// chip, a region picker needs to scale past 2 packs.

import type { PackInfo } from '../lib/contract';

export interface PackPickerOptions {
  onSwitchPack(packId: string): Promise<void>;
}

export interface PackPickerHandle {
  setPacks(packs: PackInfo[], currentId: string): void;
  /** Resyncs the displayed selection to the canonical current pack — call on
   *  every 'pack-changed' event rather than trusting the select already
   *  shows it, since that event is the single source of truth (a future
   *  code path could switch packs some other way than this picker). */
  setCurrentPack(packId: string): void;
  setEnabled(enabled: boolean): void;
}

export function mountPackPicker(container: HTMLElement, opts: PackPickerOptions): PackPickerHandle {
  container.innerHTML = `<select class="chip pack-picker-select" disabled></select>`;
  const select = container.querySelector<HTMLSelectElement>('.pack-picker-select')!;

  let switching = false;
  let currentPackId = '';

  function setPacks(packs: PackInfo[], currentId: string): void {
    select.innerHTML = packs.map((p) => `<option value="${p.id}">${p.name.toUpperCase()}</option>`).join('');
    select.value = currentId;
    currentPackId = currentId;
  }

  select.addEventListener('change', () => {
    if (switching) return;
    const packId = select.value;
    const previousId = currentPackId;
    switching = true;
    select.disabled = true;
    opts
      .onSwitchPack(packId)
      .then(() => {
        currentPackId = packId;
      })
      .catch((err) => {
        console.error('[helius] switchPack failed', err);
        select.value = previousId; // revert — the switch didn't actually happen
      })
      .finally(() => {
        switching = false;
        select.disabled = false;
      });
  });

  function setCurrentPack(packId: string): void {
    currentPackId = packId;
    select.value = packId;
  }

  function setEnabled(enabled: boolean): void {
    select.disabled = !enabled || switching;
  }

  return { setPacks, setCurrentPack, setEnabled };
}
