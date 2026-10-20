import type { ContentProps } from '@rn-primitives/popover';
import type { TriggerRef } from '@rn-primitives/popover';
import * as Haptics from 'expo-haptics';
import { type ComponentProps, type ReactNode, useRef } from 'react';
import { type GestureResponderEvent, Pressable, View } from 'react-native';

import { useSettings } from '@/hooks/use-settings';
import { cn } from '@/lib/utils';

import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Text } from './ui/text';

interface SelectOption {
  value: string;
  label: string;
}

export interface SelectInputProps<T> extends ComponentProps<typeof Input> {
  options?: T[];
  onPressItem?: (event: GestureResponderEvent, value: string) => void;
  renderItem?: (option: T) => ReactNode;
  contentProps?: ContentProps;
  emptyView?: ReactNode;
  children?: ReactNode;
  autoCloseOnChange?: boolean;
}

export function SelectInput<T extends SelectOption>(props: SelectInputProps<T>) {
  const { options = [], renderItem, onPressItem, contentProps, emptyView, children, autoCloseOnChange = true, ...inputProps } = props;
  const { className, ...others } = contentProps || {};
  const ref = useRef<TriggerRef>(null);
  const [{ hapticFeedback }] = useSettings();

  return (
    <Popover>
      <PopoverTrigger ref={ref} asChild>
        {children ? (
          children
        ) : (
          <Input
            {...inputProps}
            onChangeText={v => {
              inputProps.onChangeText?.(v);
              if (autoCloseOnChange) {
                ref.current?.close();
              }
            }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent className={cn('w-full p-1', className)} {...others}>
        {options.length > 0 ? (
          options.map(opt => {
            return (
              <Pressable
                key={opt.value}
                className="flex flex-row items-center justify-between rounded-sm px-2 py-1 active:bg-accent"
                onPress={e => {
                  if (hapticFeedback) {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  onPressItem?.(e, opt.value);
                  inputProps.onChangeText?.(opt.value);
                  ref.current?.close();
                }}>
                {renderItem ? renderItem(opt) : <Text>{opt.label}</Text>}
              </Pressable>
            );
          })
        ) : (
          <View className="py-2">{emptyView || <Text className="text-center text-sm text-muted-foreground">No Records.</Text>}</View>
        )}
      </PopoverContent>
    </Popover>
  );
}
