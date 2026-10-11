import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Dimensions,
  useColorScheme,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";

interface RawWordItem {
  id?: string;
  term?: string;
  word?: string;
  english?: string;
  vocab?: string;
  text?: string;
  front?: string;
  meaning?: string;
  korean?: string;
  definition?: string;
  translation?: string;
  back?: string;
}

interface StandardWord {
  word: string;
  meaning: string;
}

const STORAGE_KEYS = [
  "vocab-pocket-words-v1",
  "@vocab_pocket_list",
  "@vocab_pocket_words",
  "@vocab_words",
  "vocab_pocket_list",
  "words",
];

export default function FlashcardScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  const [words, setWords] = useState<StandardWord[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadWords();
    }, [])
  );

  const normalizeWord = (item: RawWordItem): StandardWord | null => {
    if (!item || typeof item !== "object") return null;
    
    // term 속성을 1순위로 탐색하도록 수정
    const word = item.term || item.word || item.english || item.vocab || item.text || item.front || "";
    const meaning = item.meaning || item.korean || item.definition || item.translation || item.back || "";
    
    if (!word && !meaning) return null;
    return { word: word || "단어 없음", meaning: meaning || "뜻 없음" };
  };

  async function loadWords() {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const keysToSearch = Array.from(new Set([...STORAGE_KEYS, ...allKeys]));

      for (const key of keysToSearch) {
        const saved = await AsyncStorage.getItem(key);
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            let list: RawWordItem[] = [];

            if (Array.isArray(parsed)) {
              list = parsed;
            } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.words)) {
              list = parsed.words;
            }

            const normalizedList: StandardWord[] = list
              .map(normalizeWord)
              .filter((item): item is StandardWord => item !== null);

            if (normalizedList.length > 0) {
              setWords(normalizedList);
              setCurrentIndex(0);
              setIsFlipped(false);
              return;
            }
          } catch {
            // JSON 파싱 에러 스킵
          }
        }
      }
      setWords([]);
    } catch (e) {
      console.error("단어 로드 실패", e);
    }
  }

  const currentWord = words[currentIndex];

  const handleNext = () => {
    if (currentIndex < words.length - 1) {
      setIsFlipped(false);
      setCurrentIndex((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setIsFlipped(false);
      setCurrentIndex((prev) => prev - 1);
    }
  };

  const handleShuffle = () => {
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    setWords(shuffled);
    setCurrentIndex(0);
    setIsFlipped(false);
  };

  const theme = {
    bg: isDark ? "#0F172A" : "#F8FAFC",
    text: isDark ? "#F8FAFC" : "#0F172A",
    subText: isDark ? "#94A3B8" : "#64748B",
    cardFrontBg: isDark ? "#1E293B" : "#FFFFFF",
    cardFrontBorder: isDark ? "#334155" : "#E2E8F0",
    cardBackBg: isDark ? "#1D4ED8" : "#2563EB",
    cardBackBorder: isDark ? "#1E40AF" : "#2563EB",
    badgeFront: isDark ? "#94A3B8" : "#64748B",
    badgeBack: "#93C5FD",
    btnBg: isDark ? "#1E293B" : "#FFFFFF",
    btnBorder: isDark ? "#334155" : "#E2E8F0",
    btnText: isDark ? "#F1F5F9" : "#1E293B",
    disabledBtnBg: isDark ? "#0F172A" : "#F1F5F9",
    disabledBtnBorder: isDark ? "#1E293B" : "#E2E8F0",
    disabledText: isDark ? "#475569" : "#CBD5E1",
    shuffleBg: isDark ? "#1E293B" : "#EFF6FF",
    shuffleText: isDark ? "#60A5FA" : "#2563EB",
  };

  if (!words.length) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={styles.emptyContainer}>
          <Ionicons name="card-outline" size={64} color={theme.subText} />
          <Text style={[styles.emptyText, { color: theme.text }]}>학습할 단어가 없습니다.</Text>
          <Text style={[styles.emptySubText, { color: theme.subText }]}>
            '연습' 탭에서 먼저 단어를 추가해 주세요!
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.progressText, { color: theme.subText }]}>
          {currentIndex + 1} / {words.length}
        </Text>
        <TouchableOpacity
          onPress={handleShuffle}
          style={[styles.shuffleBtn, { backgroundColor: theme.shuffleBg }]}
        >
          <Ionicons name="shuffle" size={20} color={theme.shuffleText} />
          <Text style={[styles.shuffleText, { color: theme.shuffleText }]}>단어 섞기</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.cardWrapper}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setIsFlipped(!isFlipped)}
          style={[
            styles.card,
            isFlipped
              ? { backgroundColor: theme.cardBackBg, borderColor: theme.cardBackBorder }
              : { backgroundColor: theme.cardFrontBg, borderColor: theme.cardFrontBorder },
          ]}
        >
          <Text style={[styles.cardBadge, { color: isFlipped ? theme.badgeBack : theme.badgeFront }]}>
            {isFlipped ? "뜻 (Meaning)" : "단어 (Word)"}
          </Text>
          <Text style={[styles.cardText, { color: isFlipped ? "#FFFFFF" : theme.text }]}>
            {isFlipped ? currentWord.meaning : currentWord.word}
          </Text>
          <Text style={[styles.flipHint, { color: isFlipped ? theme.badgeBack : theme.subText }]}>
            터치해서 뒤집기 🔄
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          onPress={handlePrev}
          disabled={currentIndex === 0}
          style={[
            styles.navBtn,
            { backgroundColor: theme.btnBg, borderColor: theme.btnBorder },
            currentIndex === 0 && {
              backgroundColor: theme.disabledBtnBg,
              borderColor: theme.disabledBtnBorder,
            },
          ]}
        >
          <Ionicons
            name="chevron-back"
            size={24}
            color={currentIndex === 0 ? theme.disabledText : theme.btnText}
          />
          <Text
            style={[
              styles.navBtnText,
              { color: theme.btnText },
              currentIndex === 0 && { color: theme.disabledText },
            ]}
          >
            이전
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleNext}
          disabled={currentIndex === words.length - 1}
          style={[
            styles.navBtn,
            styles.primaryNavBtn,
            currentIndex === words.length - 1 && {
              backgroundColor: theme.disabledBtnBg,
              borderColor: theme.disabledBtnBorder,
            },
          ]}
        >
          <Text
            style={[
              styles.navBtnText,
              styles.primaryNavBtnText,
              currentIndex === words.length - 1 && { color: theme.disabledText },
            ]}
          >
            다음
          </Text>
          <Ionicons
            name="chevron-forward"
            size={24}
            color={currentIndex === words.length - 1 ? theme.disabledText : "#FFFFFF"}
          />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const { width } = Dimensions.get("window");

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  progressText: { fontSize: 16, fontWeight: "700" },
  shuffleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  shuffleText: { fontSize: 14, fontWeight: "600" },
  cardWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: width - 48,
    height: 360,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    borderWidth: 2,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },
  cardBadge: {
    position: "absolute",
    top: 20,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardText: { fontSize: 32, fontWeight: "800", textAlign: "center" },
  flipHint: { position: "absolute", bottom: 20, fontSize: 13 },
  controls: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 16,
  },
  navBtn: {
    flex: 1,
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  primaryNavBtn: { backgroundColor: "#2563EB", borderColor: "#2563EB" },
  navBtnText: { fontSize: 16, fontWeight: "700" },
  primaryNavBtnText: { color: "#FFFFFF" },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  emptyText: { fontSize: 18, fontWeight: "700", marginTop: 16 },
  emptySubText: { fontSize: 14, marginTop: 8 },
});