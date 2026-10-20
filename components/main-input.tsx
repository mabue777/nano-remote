import * as Haptics from 'expo-haptics';
import { ArrowUpIcon, AudioLines, Lightbulb } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Keyboard, View } from 'react-native';

import { useSessions } from '@/hooks/use-sessions';
import { useSettings } from '@/hooks/use-settings';
import { useVoiceInput } from '@/hooks/use-voice-input';
import { cn } from '@/lib/utils';

import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import { Textarea } from './ui/textarea';
import { Toggle } from './ui/toggle';

export function MainInput(props: { onSend: (input: string) => Promise<void>; onAbort: () => void }) {
  const { onSend, onAbort } = props;
  const [input, setInput] = useState('');
  const [{ host, hapticFeedback }] = useSettings();
  const { current, currentSession, setSessions } = useSessions();
  const { think = false, model, messages } = currentSession || {};
  const inChatting = useMemo(() => {
    if (messages.length > 0) {
      return messages.some(({ isPending = false, isStreaming = false, isThinking = false, isAborted = false }) => (isPending || isStreaming || isThinking) && !isAborted);
    }

    return false;
  }, [messages]);
  const { recognizing, audioWaves, start, stop } = useVoiceInput({
    onResult: event => {
      const { results, isFinal } = event;
      const [{ transcript }] = results;
      if (isFinal && transcript && shouldSendRef.current) {
        onSend(transcript);
      }
    }
  });
  const [speechMode, setSpeechMode] = useState(false);
  const [pressedInside, setPressedInside] = useState(false);
  const shouldSendRef = useRef(false);

  const handleSend = async () => {
    setTimeout(() => {
      setInput('');
      Keyboard.dismiss();
    }, 0);
    await onSend(input);
  };

  const handleToggleThink = () => {
    setSessions(sessions => {
      const { current, data } = sessions;
      data[current].think = !data[current].think;
    });
  };

  useEffect(() => {
    setInput('');
  }, [current]);

  if (speechMode) {
    return (
      <View className="flex w-full flex-row items-center rounded-[48px] bg-accent p-2">
        <Toggle aria-label="Toggle speech mode" variant="outline" size="sm" className="size-9 border-0 shadow-none" pressed={speechMode} onPressedChange={() => setSpeechMode(false)}>
          <Icon as={AudioLines} className="size-5 fill-blue-500 stroke-blue-500" />
        </Toggle>
        <Button
          variant="outline"
          className="flex-1 rounded-[40px] dark:border-muted-foreground/20"
          disabled={inChatting || !model || !host}
          onPressIn={() => {
            if (hapticFeedback) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }

            setPressedInside(true);
            start();
          }}
          onPressOut={() => {
            if (hapticFeedback) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }

            setPressedInside(false);
            stop();
          }}
          onPress={async () => {
            shouldSendRef.current = true;
            stop();
          }}
          onTouchEnd={() => {
            if (!pressedInside) {
              shouldSendRef.current = false;
              stop();
            }
          }}>
          {recognizing ? (
            <View className="flex-row items-center gap-x-0.5">
              {audioWaves.map((anim, i) => (
                <Animated.View key={i} className="w-[3px] rounded-[2px] bg-blue-500" style={{ height: anim }} />
              ))}
            </View>
          ) : (
            <Text>Hold to Speak</Text>
          )}
        </Button>
        {inChatting ? (
          <Button size="icon" className="ml-2 size-9 rounded-full" onPress={onAbort}>
            <View className="size-3 rounded-[2px] bg-primary-foreground" />
          </Button>
        ) : null}
      </View>
    );
  }

  return (
    <View className="relative w-full rounded-2xl bg-accent p-2">
      <Toggle aria-label="Toggle speech mode" variant="outline" size="sm" className="absolute bottom-2 left-2 size-9 rounded-full border-0 bg-background shadow-none" pressed={speechMode} onPressedChange={() => setSpeechMode(true)}>
        <Icon as={AudioLines} className="size-4" />
      </Toggle>
      <Textarea value={input} onChangeText={setInput} className="h-auto max-h-[250px] min-h-10 w-full resize-none rounded-2xl border-0" placeholder="Send a message" />
      <View className="mt-2 flex w-full flex-row items-center justify-end gap-x-2">
        {model?.canThink ? (
          <Toggle aria-label="Toggle thinking" variant="outline" size="sm" className="size-9 rounded-full border-0 bg-background shadow-none" pressed={think || false} onPressedChange={handleToggleThink}>
            <Icon as={Lightbulb} className={cn('size-4', think ? 'fill-blue-500 stroke-blue-500' : '')} />
          </Toggle>
        ) : null}
        {inChatting ? (
          <Button size="icon" className="size-9 rounded-full" onPress={onAbort}>
            <View className="size-3 rounded-[2px] bg-primary-foreground" />
          </Button>
        ) : (
          <Button size="icon" className="size-9 rounded-full" disabled={!input || !model || !host} onPress={handleSend}>
            <Icon as={ArrowUpIcon} className="size-4 text-primary-foreground" />
          </Button>
        )}
      </View>
    </View>
  );
}
