import { withImmer } from '@/lib/utils';
import { settings } from '@/store/settings';

import { useStorageAtom } from './use-storage-atom';

export const useSettings = () => {
  const [_settings, _setSettings] = useStorageAtom(settings);

  return [_settings, withImmer(_setSettings)] as const;
};
