import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { Edit, MoonStarIcon, Sidebar, SunIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useEffect, useRef } from 'react';
import { Image, KeyboardAvoidingView, ScrollView, TouchableOpacity, View } from 'react-native';
import ReanimatedDrawerLayout, { DrawerLayoutMethods } from 'react-native-gesture-handler/ReanimatedDrawerLayout';

import { DrawerContent } from '@/components/drawer-content';
import { MainInput } from '@/components/main-input';
import { MessageList } from '@/components/message-list';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useChat } from '@/hooks/use-chat';
import { useLiveActivity } from '@/hooks/use-live-activity';
import { useModels } from '@/hooks/use-models';
import { useSessions } from '@/hooks/use-sessions';
import { useSettings } from '@/hooks/use-settings';
import { useUpdateEffect } from '@/hooks/use-update-effect';
import { STOP_LIVE_ACTIVITY_ACTION_TARGET } from '@/lib/constants';

const LOGO = {
  light: require('@/assets/images/logo.png'),
  dark: require('@/assets/images/logo-dark.png')
};

const THEME_ICONS = {
  light: SunIcon,
  dark: MoonStarIcon
};

const IMAGE_STYLE = {
  height: 64,
  width: 64
};

function Header(props: { handlePressSidebarIcon: () => void }) {
  const { handlePressSidebarIcon } = props;
  const { colorScheme, toggleColorScheme } = useColorScheme();
  const [{ provider }] = useSettings();
  const { messages } = useChat();
  const { createSession } = useSessions();
  const { currentModel, setCurrentModel } = useModels();
  const router = useRouter();

  useUpdateEffect(() => {
    if (messages.length === 0) {
      setCurrentModel(void 0);
    }
  }, [provider]);

  return (
    <View className="pt-safe absolute z-10 flex w-full flex-row items-center bg-background pb-1">
      <Button onPress={handlePressSidebarIcon} size="icon" variant="ghost" className="top-safe absolute left-2 size-9 rounded-full">
        <Icon as={Sidebar} className="size-[18px]" />
      </Button>
      <Button onPress={toggleColorScheme} size="icon" variant="ghost" className="top-safe absolute left-10 size-9 rounded-full">
        <Icon as={THEME_ICONS[colorScheme ?? 'light']} className="size-[18px]" />
      </Button>
      <View className="flex-1 items-center">
        <View className="flex flex-row items-center gap-x-1">
          {messages.length > 0 ? <Image source={LOGO[colorScheme ?? 'light']} resizeMode="contain" className="mb-1 size-6" /> : null}
          <Text className="text-base font-medium">Nano AI</Text>
        </View>
        <TouchableOpacity onPress={() => router.push('/models')}>
          <Text style={{ fontFamily: 'Google_Sans_Code' }} className="text-xs text-muted-foreground">
            {currentModel ? currentModel.name : 'select a model to start...'}
          </Text>
        </TouchableOpacity>
      </View>
      <Button onPress={createSession} size="icon" variant="ghost" className="top-safe absolute right-2 size-9 rounded-full">
        <Icon as={Edit} className="size-[18px]" />
      </Button>
    </View>
  );
}

export default function Index() {
  const { colorScheme } = useColorScheme();
  const { start: startLiveActivity, stop: stopLiveActivity, running } = useLiveActivity();
  const [, setSettings] = useSettings();
  const { current, currentSession } = useSessions();
  const drawerRef = useRef<DrawerLayoutMethods>(null);
  const { messages, error, sendMessage, stop, regenerate, clearError } = useChat({
    onFinished: ({ totalUsage }) => {
      if (totalUsage) {
        setSettings(settings => {
          settings.tokensUsage += totalUsage.totalTokens || 0;
        });
      }
    }
  });
  const requestAbortMap = useRef<Record<string, () => void>>({});

  const handleSend = async (input: string) => {
    if (running) stopLiveActivity();

    requestAbortMap.current[current] = stop;
    startLiveActivity(input, currentSession.model!.name);
    clearError();
    await sendMessage(input);
  };

  const handleRegenerate = async (index: number) => {
    requestAbortMap.current[current] = stop;
    clearError();
    await regenerate(index);
  };

  const handleAbort = () => {
    requestAbortMap.current[current]?.call(null);
    stopLiveActivity();
  };

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      const { queryParams } = Linking.parse(url);
      const { from, action } = queryParams || {};
      if (from === 'dynamic-island' && action === STOP_LIVE_ACTIVITY_ACTION_TARGET) {
        handleAbort();
      }
    });

    return () => sub.remove();
  }, []);

  useEffect(() => {
    clearError();
  }, [current]);

  return (
    <ReanimatedDrawerLayout
      ref={drawerRef}
      drawerWidth={300}
      renderNavigationView={() => (
        <DrawerContent
          close={() => {
            drawerRef.current?.closeDrawer();
          }}
        />
      )}>
      <View className="flex flex-1">
        <Header
          handlePressSidebarIcon={() => {
            drawerRef.current?.openDrawer();
          }}
        />
        {messages.length > 0 ? (
          <KeyboardAvoidingView behavior="padding" className="flex flex-1 flex-col items-center justify-center">
            <MessageList data={messages} error={error} onRegenerate={handleRegenerate} />
            <View className="pb-safe px-safe-offset-4 w-full pt-2">
              <MainInput onSend={handleSend} onAbort={handleAbort} />
            </View>
          </KeyboardAvoidingView>
        ) : (
          <ScrollView contentContainerClassName="flex-1" scrollEnabled={false} keyboardShouldPersistTaps="handled">
            <KeyboardAvoidingView behavior="padding" className="flex flex-1">
              <View className="flex flex-1 items-center justify-center gap-y-2">
                <Image source={LOGO[colorScheme ?? 'light']} style={IMAGE_STYLE} resizeMode="contain" />
              </View>
              <View className="pb-safe px-safe-offset-4 w-full pt-2">
                <MainInput onSend={handleSend} onAbort={handleAbort} />
              </View>
            </KeyboardAvoidingView>
          </ScrollView>
        )}
      </View>
    </ReanimatedDrawerLayout>
  );
}
