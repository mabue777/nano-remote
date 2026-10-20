import type { PropsWithChildren } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

export function SettingSection(props: PropsWithChildren<{ className?: string }>) {
  const { className, children } = props;

  return <View className={cn('flex gap-2 rounded-lg bg-accent p-2', className)}>{children}</View>;
}
