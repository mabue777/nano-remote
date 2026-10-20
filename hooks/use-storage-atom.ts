import { useAtom } from 'jotai';

import type { StoredAtom } from '@/lib/local-storage';

export function useStorageAtom<V>(atom: StoredAtom<V>) {
  const [data, setData] = useAtom(atom);

  return [
    data,
    (update: (data: V) => V) => {
      // use setTimeout to make sure the primitive data has promised
      setTimeout(() => {
        setData(async promise => {
          return update(await promise);
        });
      }, 0);
    }
  ] as const;
}
