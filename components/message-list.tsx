import { AlertCircleIcon, ArrowDown, Lightbulb, RefreshCcw } from 'lucide-react-native';
import { useMemo, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { FadeIn, FadeOut } from 'react-native-reanimated';

import { useScrollToEnd } from '@/hooks/use-scroll-to-end';
import { useSettings } from '@/hooks/use-settings';
import { useThemeColor } from '@/hooks/use-theme-color';
import { useUpdateLayoutEffect } from '@/hooks/use-update-effect';
import { AIProviderEnum } from '@/lib/ai';
import type { UIMessage } from '@/store/sessions';

import { Copy } from './copy';
import { Markdown } from './markdown';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { NativeOnlyAnimatedView } from './ui/native-only-animated-view';
import { Separator } from './ui/separator';
import { Spinner } from './ui/spinner';
import { Text } from './ui/text';

export function MessageList(props: { data: UIMessage[]; onRegenerate: (index: number) => void; error: Error | null }) {
  const { data, error, onRegenerate } = props;
  const { mutedForeground } = useThemeColor();
  const [{ provider }] = useSettings();
  const { scroller, scrollToEnd, handleScroll, handleLayout, handleContentSizeChange, isAtEnd } = useScrollToEnd(200);
  const autoScrollEnabled = useRef(true);
  const messagePositions = useRef<number[]>([]);
  const inChatting = useMemo(() => {
    if (data.length > 0) {
      return data.some(({ isPending = false, isStreaming = false, isThinking = false, isAborted = false }) => (isPending || isStreaming || isThinking) && !isAborted);
    }

    return false;
  }, [data]);
  const allowRegenerate = provider !== AIProviderEnum.OPENCLAW;

  useUpdateLayoutEffect(() => {
    if (isAtEnd) {
      autoScrollEnabled.current = true;
    }
  }, [isAtEnd]);

  return (
    <View className="pt-safe-offset-12 relative flex-1">
      <ScrollView
        ref={scroller}
        keyboardShouldPersistTaps="handled"
        onLayout={handleLayout}
        onScroll={handleScroll}
        onScrollBeginDrag={() => {
          if (inChatting && autoScrollEnabled.current) {
            autoScrollEnabled.current = false;
          }
        }}
        onContentSizeChange={(...args) => {
          if (inChatting && autoScrollEnabled.current) {
            scrollToEnd();
          }
          handleContentSizeChange(...args);
        }}>
        <View className="px-safe-offset-4 flex flex-1 gap-y-4">
          {data.map(({ role, content, thinkingContent, thinkingDuration, isPending, isThinking, isStreaming, cost }, index) => {
            if (role === 'user') {
              return (
                <View
                  key={index}
                  className="flex w-full scroll-mt-5 flex-row justify-end"
                  onLayout={e => {
                    messagePositions.current[index] = e.nativeEvent.layout.y;
                  }}>
                  <Text className="w-max max-w-[75%] rounded-[20px] bg-accent px-4 py-2 font-medium leading-6" selectable>
                    {content}
                  </Text>
                </View>
              );
            }

            if (isPending) {
              return (
                <View key={index} className="mr-auto w-max rounded-[20px] bg-accent px-4 py-3">
                  <Spinner />
                </View>
              );
            }

            return (
              <View key={index}>
                {isThinking !== void 0 ? (
                  <>
                    <View className="flex flex-row items-center gap-x-1">
                      <Icon as={Lightbulb} size={20} />
                      <Text>{isThinking ? 'Thinking....' : `Thought for ${((thinkingDuration || 0) / 1000).toFixed(1)} seconds`}</Text>
                    </View>
                    {thinkingContent ? (
                      <View className="pl-[26px]">
                        <Markdown content={thinkingContent} style={{ fontSize: 14, color: mutedForeground, lineHeight: 21 }} />
                      </View>
                    ) : null}
                  </>
                ) : null}
                <Markdown content={content} style={{ lineHeight: 24 }} />
                {isStreaming || isThinking || isPending ? null : (
                  <View className="flex flex-row items-center gap-x-1">
                    {cost?.time ? (
                      <>
                        <Text className="text-sm tabular-nums text-muted-foreground">{cost.time / 1000} s</Text>
                        <Separator orientation="vertical" className="mx-1 h-4" />
                        <Text className="text-sm tabular-nums text-muted-foreground">{cost.tokens.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} tokens</Text>
                        <Separator orientation="vertical" className="ml-1 h-4" />
                      </>
                    ) : null}
                    <Copy className="w-10 text-muted-foreground" content={content} iconSize={16} showText={false} />
                    {allowRegenerate ? (
                      <>
                        <Separator orientation="vertical" className="h-4" />
                        <Button
                          variant="ghost"
                          size="icon"
                          onPress={() => {
                            autoScrollEnabled.current = false;
                            const userMsgIndex = index - 1;
                            scroller.current?.scrollTo({ y: Math.max(0, messagePositions.current[userMsgIndex] - 16), animated: true });
                            onRegenerate(index);
                          }}>
                          <Icon as={RefreshCcw} size={16} />
                        </Button>
                      </>
                    ) : null}
                  </View>
                )}
              </View>
            );
          })}
          {error ? (
            <View>
              <Alert variant="destructive" icon={AlertCircleIcon}>
                <AlertTitle>{error.name}</AlertTitle>
                <AlertDescription style={{ fontFamily: 'Google_Sans_Code' }}>{'responseBody' in error && error.responseBody ? JSON.stringify(JSON.parse(error.responseBody as string), null, 2) : error.message}</AlertDescription>
              </Alert>
              {allowRegenerate ? (
                <Button variant="secondary" className="mt-2 w-full" onPress={() => onRegenerate(-1)}>
                  <Text>Retry</Text>
                </Button>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
      {isAtEnd ? null : (
        <NativeOnlyAnimatedView entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)}>
          <Button size="icon" className="absolute bottom-0 left-[50%] translate-x-[-50%] rounded-full" variant="outline" onPress={() => scrollToEnd()}>
            <Icon as={ArrowDown} size={18} />
          </Button>
        </NativeOnlyAnimatedView>
      )}
    </View>
  );
}
