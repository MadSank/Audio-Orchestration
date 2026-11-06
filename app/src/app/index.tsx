import { type ComponentRef, useRef } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";

import Crate from "../screens/Crate";
import Helmet from "../screens/Helmet";
import Stations from "../screens/Stations";
import { color } from "../theme/tokens";

/** The three main screens, side by side: swipe between them. There's no bar to tap. */
export default function Home() {
  const { width } = useWindowDimensions();
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView ref={pager} horizontal pagingEnabled showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: color.night }}>
      <View style={{ width }}><Stations onOpenHelmet={() => pager.current?.scrollTo({ x: width * 2, animated: true })} /></View>
      <View style={{ width }}><Crate /></View>
      <View style={{ width }}><Helmet /></View>
    </ScrollView>
  );
}
