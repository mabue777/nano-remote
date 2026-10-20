import { ScrollView, View } from 'react-native';

import { Actions } from '@/components/settings/actions';
import { Server } from '@/components/settings/server';
import { System } from '@/components/settings/system';

export default function Settings() {
  return (
    <ScrollView className="pt-safe-offset-14 flex-1 px-4">
      <View className="flex gap-y-4">
        <Server />
        <System />
        <Actions />
      </View>
    </ScrollView>
  );
}
