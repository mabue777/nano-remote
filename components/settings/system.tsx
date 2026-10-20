import type { TriggerRef } from '@rn-primitives/select';
import * as Haptics from 'expo-haptics';
import { AudioLines, Braces, MoonStar, Sun, SunMoon, Vibrate } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useRef } from 'react';
import { View } from 'react-native';

import { useSettings } from '@/hooks/use-settings';

import { SettingSection } from '../setting-section';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';
import { Switch } from '../ui/switch';
import { Text } from '../ui/text';

export function System() {
  const ref = useRef<TriggerRef>(null);
  const { colorScheme, setColorScheme } = useColorScheme();
  const [settings, setSettings] = useSettings();
  const { hapticFeedback, tokensUsage = 0, voiceLanguage = 'en-US' } = settings;

  return (
    <SettingSection>
      <View className="flex h-10 flex-row items-center">
        <View className="flex flex-1 flex-row items-center gap-x-2">
          <Icon as={SunMoon} size={18} />
          <Text className="font-medium">Appearance</Text>
        </View>
        <Select
          value={{ label: '', value: colorScheme || 'light' }}
          onValueChange={opt => {
            setColorScheme(opt?.value as 'light' | 'dark' | 'system');
          }}>
          <SelectTrigger ref={ref} className="w-[40px] border-0 bg-transparent p-0 shadow-none dark:bg-transparent" showIcon={false}>
            <Button
              size="icon"
              variant="ghost"
              className="ml-1"
              onPress={() => {
                ref.current?.open();
              }}>
              <Icon as={colorScheme === 'light' ? Sun : MoonStar} />
            </Button>
          </SelectTrigger>
          <SelectContent insets={{ right: 16 }} className="w-[100px]" side="bottom">
            <SelectItem label="Light" value="light" />
            <SelectItem label="Dark" value="dark" />
            <SelectItem label="System" value="system" showCheck={false} />
          </SelectContent>
        </Select>
      </View>
      <View className="flex h-10 flex-row items-center">
        <View className="flex flex-1 flex-row items-center gap-x-2">
          <Icon as={Vibrate} size={18} />
          <Text className="font-medium">Haptic Feedback</Text>
        </View>
        <Switch
          checked={hapticFeedback}
          onCheckedChange={value => {
            setSettings(settings => {
              settings.hapticFeedback = value;
            });
          }}
        />
      </View>
      <View className="flex h-10 flex-row items-center">
        <View className="flex flex-1 flex-row items-center gap-x-2">
          <Icon as={Braces} size={18} />
          <Text className="font-medium">Tokens Usage</Text>
        </View>
        <Text className="text-muted-foreground">{tokensUsage.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</Text>
      </View>
      <View className="flex h-10 flex-row items-center">
        <View className="flex flex-1 flex-row items-center gap-x-2">
          <Icon as={AudioLines} size={18} />
          <Text className="font-medium">Voice</Text>
        </View>
        <Select
          value={{ label: '', value: voiceLanguage }}
          onValueChange={opt => {
            setSettings(settings => {
              settings.voiceLanguage = opt?.value as 'en-US' | 'zh-CN';
            });
          }}>
          <SelectTrigger
            className="border-0 bg-transparent p-0 shadow-none dark:bg-transparent"
            showIcon={false}
            onPress={() => {
              if (hapticFeedback) {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }
            }}>
            <Text className="text-muted-foreground">{voiceLanguage === 'en-US' ? 'English' : 'Chinese'}</Text>
          </SelectTrigger>
          <SelectContent insets={{ right: 16 }} className="w-[100px]" side="bottom">
            <SelectItem label="English" value="en-US" />
            <SelectItem label="Chinese" value="zh-CN" />
          </SelectContent>
        </Select>
      </View>
    </SettingSection>
  );
}
