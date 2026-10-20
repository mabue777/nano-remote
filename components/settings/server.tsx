import { fetch } from 'expo/fetch';
import { Command, LaptopMinimal, Lock } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useState } from 'react';
import { Image, type ImageURISource, Pressable, View } from 'react-native';

import { useSettings } from '@/hooks/use-settings';
import { useToast } from '@/hooks/use-toast';
import { AIProviderEnum, AIRegistry, chat } from '@/lib/ai';
import { cn } from '@/lib/utils';

import { SelectInput } from '../select-input';
import { SettingSection } from '../setting-section';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Spinner } from '../ui/spinner';
import { Text } from '../ui/text';

const providerIcon: Record<AIProviderEnum, { light: ImageURISource; dark: ImageURISource }> = {
  [AIProviderEnum.OLLAMA]: {
    light: require('@/assets/providers/ollama.png'),
    dark: require('@/assets/providers/ollama-dark.png')
  },
  [AIProviderEnum.OPENAI]: {
    light: require('@/assets/providers/openai.png'),
    dark: require('@/assets/providers/openai-dark.png')
  },
  [AIProviderEnum.ANTHROPIC]: {
    light: require('@/assets/providers/anthropic.png'),
    dark: require('@/assets/providers/anthropic-dark.png')
  },
  [AIProviderEnum.GOOGLE]: {
    light: require('@/assets/providers/gemini.png'),
    dark: require('@/assets/providers/gemini-dark.png')
  },
  [AIProviderEnum.CUSTOM]: {
    light: require('@/assets/providers/openai.png'),
    dark: require('@/assets/providers/openai-dark.png')
  },
  [AIProviderEnum.OPENCLAW]: {
    light: require('@/assets/providers/openclaw.png'),
    dark: require('@/assets/providers/openclaw-dark.png')
  }
};

export function Server() {
  const { colorScheme } = useColorScheme();
  const toast = useToast();
  const [settings, setSettings] = useSettings();
  const { provider = AIProviderEnum.OLLAMA, host, apiKey, endpoints = [] } = settings;
  const [connectStatus, setTestingStatus] = useState<'pending' | 'successful' | 'failed'>();

  const dispatch = <K extends 'provider' | 'host' | 'apiKey'>(key: K) => {
    return (v: (typeof settings)[K]) => {
      setSettings(prev => ({ ...prev, [key]: v }));
    };
  };

  const handleTestConnection = async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    try {
      setTestingStatus('pending');
      switch (provider) {
        case AIProviderEnum.ANTHROPIC: {
          const registry = new AIRegistry(host, apiKey);
          await chat({ model: registry.model(`${provider}:claude-3-haiku-20240307`), messages: [{ role: 'user', content: 'Hi' }] });

          break;
        }
        case AIProviderEnum.OPENAI: {
          const registry = new AIRegistry(host, apiKey);
          await chat({ model: registry.model(`${provider}:gpt-3.5-turbo`), messages: [{ role: 'user', content: 'Hi' }] });

          break;
        }
        case AIProviderEnum.GOOGLE: {
          const registry = new AIRegistry(host, apiKey);
          await chat({ model: registry.model(`${provider}:gemini-2.5-flash`), messages: [{ role: 'user', content: 'Hi' }] });

          break;
        }
        case AIProviderEnum.OLLAMA: {
          const result = await fetch(`${host}/api/tags`, { method: 'GET', headers });

          if (!result.ok) throw Error(`${result.status} ${result.statusText}`);
          await result.json();

          break;
        }
        case AIProviderEnum.CUSTOM:
        case AIProviderEnum.OPENCLAW: {
          const result = await fetch(`${host}/models`, { method: 'GET', headers });

          if (!result.ok) throw Error(`${result.status} ${result.statusText}`);
          await result.json();

          break;
        }
      }

      setSettings(settings => {
        settings.defaultModel = void 0;

        if (!settings.endpoints) settings.endpoints = [];
        const newEndpoint = { provider, host, apiKey, isLastUsed: true };
        const endpointIndex = settings.endpoints.findIndex(e => e.provider === provider);
        if (endpointIndex > -1) {
          settings.endpoints.forEach(e => (e.isLastUsed = false));
          settings.endpoints[endpointIndex] = newEndpoint;
        } else {
          settings.endpoints = [newEndpoint, ...settings.endpoints.map(e => ({ ...e, isLastUsed: false }))].slice(0, 6);
        }
      });
      setTestingStatus('successful');
      toast.success('Connect successfully!', { position: 'bottom' });
    } catch (error) {
      setTestingStatus('failed');
      toast.error('Connect failed!', { position: 'bottom', description: `${error}` });
    }
  };

  return (
    <>
      <SettingSection>
        <View className="flex flex-row items-center justify-between">
          <View className="flex flex-row gap-x-2">
            {endpoints.length ? (
              endpoints.map(({ provider: p, host: h, apiKey: k }) => {
                const isMatched = provider === p && host === h && apiKey === k;

                return (
                  <Button
                    key={p}
                    variant={isMatched ? 'outline' : 'secondary'}
                    size="icon"
                    className={cn('size-10 rounded-full border border-border dark:border-muted-foreground/20', isMatched && 'dark:bg-black')}
                    onPress={() =>
                      setSettings(settings => {
                        settings.provider = p;
                        settings.host = h;
                        settings.apiKey = k;
                        settings.endpoints.forEach(e => (e.isLastUsed = e.provider === p));
                      })
                    }>
                    <Image source={providerIcon[p][colorScheme ?? 'light']} className="size-6" />
                  </Button>
                );
              })
            ) : (
              <Text className="text-sm text-muted-foreground">No Records</Text>
            )}
          </View>
          <Button disabled={connectStatus === 'pending'} onPress={handleTestConnection}>
            <Text>{connectStatus === 'pending' ? 'Connecting' : 'Test Connection'}</Text>
            {connectStatus === 'pending' ? <Spinner className="text-background" /> : null}
          </Button>
        </View>
      </SettingSection>
      <SettingSection>
        <View className="flex h-10 flex-row items-center">
          <View className="flex flex-1 flex-row items-center gap-x-2">
            <Icon as={Command} size={18} />
            <Text className="font-medium">Provider</Text>
          </View>
          <SelectInput
            value={provider}
            onPressItem={(_, value) => {
              setSettings(settings => {
                if (settings.provider !== value) {
                  settings.host = '';
                  settings.apiKey = '';
                }
                settings.provider = value as AIProviderEnum;
              });
            }}
            options={[
              { label: 'Ollama', value: 'ollama' },
              { label: 'OpenAI', value: 'openai' },
              { label: 'Anthropic', value: 'anthropic' },
              { label: 'Google', value: 'google' },
              { label: 'OpenAI Compatible', value: 'custom' },
              { label: 'OpenClaw (Experimental)', value: 'openclaw' }
            ]}
            contentProps={{
              insets: { left: 16, right: 16 },
              sideOffset: 12
            }}
            renderItem={({ label, value }) => {
              return (
                <View className="flex h-8 w-full flex-row items-center justify-between">
                  <Text>{label}</Text>
                  <Image source={providerIcon[value as AIProviderEnum][colorScheme ?? 'light']} resizeMode="contain" className="mr-1 size-6" />
                </View>
              );
            }}>
            <Pressable>
              <Image source={providerIcon[provider][colorScheme ?? 'light']} resizeMode="contain" className="size-7" />
            </Pressable>
          </SelectInput>
        </View>
        <View className="flex flex-row items-center justify-between">
          <View className="flex flex-row items-center gap-x-2">
            <Icon as={Lock} size={18} />
            <Text className="font-medium">API Key</Text>
          </View>
          <View className="min-w-0 flex-1">
            <SelectInput
              value={apiKey}
              placeholder="e.g. sk-..."
              className="border-0 bg-transparent pr-1 text-right dark:bg-transparent"
              onChangeText={dispatch('apiKey')}
              secureTextEntry
              options={endpoints.map(({ apiKey, isLastUsed }) => ({
                value: apiKey,
                label: apiKey
                  ? `${apiKey.slice(0, 3)}${Array(apiKey.length - 7)
                      .fill('*')
                      .join('')}${apiKey.slice(-4)}`
                  : '',
                isLastUsed
              }))}
              contentProps={{
                insets: { left: 16, right: 16 }
              }}
              renderItem={({ label, isLastUsed }) => {
                return (
                  <View className="flex flex-1 flex-row items-center justify-between gap-x-2 py-1">
                    <Text className="flex-1" numberOfLines={1}>
                      {label}
                    </Text>
                    {isLastUsed ? <Text className="text-sm text-muted-foreground">last used</Text> : null}
                  </View>
                );
              }}
            />
          </View>
        </View>
        <View className="flex flex-row items-center justify-between">
          <View className="flex flex-row items-center gap-x-2">
            <Icon as={LaptopMinimal} size={18} />
            <Text className="font-medium">Host</Text>
          </View>
          <View className="min-w-0 flex-1">
            <SelectInput
              value={host}
              placeholder="e.g. https://api.openai.com/v1"
              className="border-0 bg-transparent pr-1 text-right dark:bg-transparent"
              onChangeText={dispatch('host')}
              options={endpoints.map(({ host, isLastUsed }) => ({ value: host, label: host, isLastUsed }))}
              contentProps={{
                insets: { left: 16, right: 16 }
              }}
              renderItem={({ label, isLastUsed }) => {
                return (
                  <View className="flex flex-1 flex-row items-center justify-between gap-x-2 py-1">
                    <Text>{label}</Text>
                    {isLastUsed ? <Text className="text-sm text-muted-foreground">last used</Text> : null}
                  </View>
                );
              }}
            />
          </View>
        </View>
      </SettingSection>
    </>
  );
}
