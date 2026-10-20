import { useRouter } from 'expo-router';
import { CloudAlert, Lightbulb } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useModels } from '@/hooks/use-models';
import { useSettings } from '@/hooks/use-settings';
import { useUpdateEffect } from '@/hooks/use-update-effect';
import { cn } from '@/lib/utils';
import type { Model } from '@/store/settings';

export default function ModalScreen() {
  const router = useRouter();
  const [, setSettings] = useSettings();
  const { models, currentModel, fetchModels, setCurrentModel } = useModels();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [customModel, setCustomModel] = useState<Model>(currentModel?.isCustom ? currentModel : { name: '', canThink: false, isCustom: true });
  const [useCustomModel, setUseCustomModel] = useState(currentModel?.isCustom ?? false);

  const handleSelectModel = (model?: Model) => {
    setCurrentModel(model);
    setSettings(settings => {
      settings.defaultModel = model;
    });
  };

  useEffect(() => {
    setLoading(true);
    fetchModels()
      .catch(setError)
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useUpdateEffect(() => {
    if (!useCustomModel) {
      handleSelectModel();
    } else if (customModel?.name) {
      handleSelectModel(customModel);
    }
  }, [useCustomModel, customModel]);

  if (error) {
    return (
      <View className="flex h-full flex-1 items-center justify-center px-2">
        <CloudAlert size={44} />
        <Text className="text-xl font-medium">Models discovering error</Text>
        <Text className="text-center text-muted-foreground">{`${error.message}`}</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View className="flex h-full flex-1 items-center justify-center gap-y-1">
        <Spinner className="size-6" />
        <Text>Discovering available models...</Text>
      </View>
    );
  }

  return (
    <ScrollView>
      <View className="pb-safe space-y-1 pt-2">
        <View className="mx-3 gap-y-3 rounded-lg py-2">
          <View className="flex flex-row items-center gap-3">
            <Checkbox disabled={!customModel.name} checked={useCustomModel} onCheckedChange={setUseCustomModel} />
            <View className="flex-1">
              <Input
                placeholder="Custom model name"
                value={customModel.name}
                onChangeText={value => {
                  if (!value) {
                    setUseCustomModel(false);
                    handleSelectModel();
                  }

                  setCustomModel(m => ({ ...m, name: value }));
                }}
              />
            </View>
          </View>
          <View className="flex flex-row items-center justify-between pl-9">
            <Text className="text-sm text-muted-foreground">Supports thinking</Text>
            <Switch
              checked={customModel.canThink ?? false}
              onCheckedChange={value => {
                setCustomModel(m => ({ ...m, canThink: value }));
              }}
            />
          </View>
        </View>
        <Separator />
        <View className="flex gap-y-1 px-2 pt-2">
          {[...models]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(model => {
              const { name, canThink } = model;
              const isCurrent = name === currentModel?.name && !currentModel.isCustom;

              return (
                <Button
                  key={name}
                  variant="ghost"
                  className={cn('flex flex-row justify-between', isCurrent ? 'bg-accent' : '')}
                  onPress={() => {
                    handleSelectModel(model);

                    router.dismiss();
                  }}>
                  <Text className="text-base">{name}</Text>
                  {canThink ? (
                    <Badge variant="secondary" className="rounded-full">
                      <Icon as={Lightbulb} className="text-blue-500" />
                    </Badge>
                  ) : null}
                </Button>
              );
            })}
        </View>
      </View>
    </ScrollView>
  );
}
