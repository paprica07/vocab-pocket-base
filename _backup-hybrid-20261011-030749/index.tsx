import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import Constants from 'expo-constants';
import { getApiBaseUrl } from "@/constants/oauth";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { parseWords, removeBuiltInWords, shuffle, type Word } from "@/lib/vocab-utils";
import { gradeAnswers, type WorksheetKind } from "@/lib/worksheet-utils";
import { createAnswerPdf, createExamPdf, type PdfQuestion } from "@/lib/native-pdf";
import { trpc } from "@/lib/trpc";

type Mode = "practice" | "add" | "library" | "history" | "worksheet" | "answer";
type QuestionType = "engkor" | "koreng" | "mix";
type OrderType = "normal" | "random";
type GradingStage = "idle" | "reading" | "grading";

type QuizQuestion = {
  word: Word;
  direction: "engkor" | "koreng";
  question: string;
  answer: string;
};

type QuizSummary = {
  score: number;
  total: number;
};

type WordHistory = Word & {
  addedAt: number;
  deletedAt?: number;
};

const WORDS_KEY = "vocab-pocket-words-v1";
const KNOWN_KEY = "vocab-pocket-known-v1";
const WRONG_KEY = "vocab-pocket-wrong-v1";
const HISTORY_KEY = "vocab-pocket-history-v1";
const PDF_DIRECTORY_KEY = "vocab-pocket-pdf-directory-v1";
const PDF_EXAM_CREATED_KEY = "vocab-pocket-exam-created-v1";

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  engkor: "영어 → 한글",
  koreng: "한글 → 영어",
  mix: "혼합",
};

const ORDER_LABELS: Record<OrderType, string> = {
  normal: "입력 순서",
  random: "랜덤",
};

function normalizeAnswerToken(value: string) {
  return value.toLowerCase().replace(/[\s.,!?，。！？]/g, "").trim();
}

function isFlexibleCorrectAnswer(input: string, answerString: string) {
  const normalizedInput = normalizeAnswerToken(input);
  if (!normalizedInput) return false;

  const candidates = answerString
    .split(/[,/;|]/)
    .map(normalizeAnswerToken)
    .filter(Boolean);

  if (!candidates.length) return false;

  if (candidates.some((c) => c === normalizedInput)) return true;

  const inputTokens = input
    .split(/[\s,/;|]+/)
    .map(normalizeAnswerToken)
    .filter(Boolean);

  if (inputTokens.length > 0) {
    const allTokensMatch = inputTokens.every((token) => candidates.includes(token));
    if (allTokensMatch) return true;
  }

  return false;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("자동채점 서버가 5분 이상 응답하지 않았습니다. 잠시 후 다시 시도해 주세요."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForServerReady(apiBaseUrl: string) {
  const healthUrl = `${apiBaseUrl}/api/health`;
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(healthUrl, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });

        if (response.ok) {
          return;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Render가 깨어나는 동안에는 연결 실패를 무시하고 다시 확인
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  throw new Error(
    "서버가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.",
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const [mode, setMode] = useState<Mode>("practice");
  const [words, setWords] = useState<Word[]>([]);
  const [history, setHistory] = useState<WordHistory[]>([]);
  const [knownIds, setKnownIds] = useState<string[]>([]);
  const [wrongIds, setWrongIds] = useState<string[]>([]);
  const [inputText, setInputText] = useState("");
  const [countText, setCountText] = useState("");
  const [questionType, setQuestionType] = useState<QuestionType>("engkor");
  const [orderType, setOrderType] = useState<OrderType>("normal");
  const [feedback, setFeedback] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [lastQuiz, setLastQuiz] = useState<QuizQuestion[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerText, setAnswerText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizSummary, setQuizSummary] = useState<QuizSummary | null>(null);
  const [showAnswerKey, setShowAnswerKey] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [worksheetInput, setWorksheetInput] = useState("");
  const [uploadedAnswerName, setUploadedAnswerName] = useState("");
  const [gradeSummary, setGradeSummary] = useState<ReturnType<typeof gradeAnswers> | null>(null);
  const [gradeFeedback, setGradeFeedback] = useState("");
  const [gradingStage, setGradingStage] = useState<GradingStage>("idle");
  const [toastMessages, setToastMessages] = useState<Array<{ id: number; message: string }>>([]);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const progressToastIdRef = useRef<number | null>(null);
  const directoryPermissionRef = useRef<Promise<string | null> | null>(null);
  const gradePdfMutation = trpc.worksheet.gradePdf.useMutation();

  useEffect(() => {
    async function loadLocalData() {
      try {
        const [storedWords, storedKnown, storedWrong, storedHistory] = await Promise.all([
          AsyncStorage.getItem(WORDS_KEY),
          AsyncStorage.getItem(KNOWN_KEY),
          AsyncStorage.getItem(WRONG_KEY),
          AsyncStorage.getItem(HISTORY_KEY),
        ]);
        const savedWords: Word[] = storedWords ? JSON.parse(storedWords) : [];
        const cleanedWords = removeBuiltInWords(savedWords);
        const savedHistory: WordHistory[] = storedHistory
          ? JSON.parse(storedHistory)
          : cleanedWords.map((word, index) => ({ ...word, addedAt: Date.now() - (cleanedWords.length - index) * 1000 }));
        setWords(cleanedWords);
        setHistory(savedHistory.filter((entry) => !entry.id.startsWith("sample-")));
        setKnownIds(storedKnown ? JSON.parse(storedKnown) : []);
        setWrongIds(storedWrong ? JSON.parse(storedWrong) : []);
      } catch {
        setWords([]);
        setHistory([]);
        setKnownIds([]);
        setWrongIds([]);
        setFeedback("저장된 단어를 불러오지 못했습니다. 새 단어를 추가해 주세요.");
      } finally {
        setHydrated(true);
      }
    }

    loadLocalData();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(WORDS_KEY, JSON.stringify(words)).catch(() => undefined);
    AsyncStorage.setItem(KNOWN_KEY, JSON.stringify(knownIds)).catch(() => undefined);
    AsyncStorage.setItem(WRONG_KEY, JSON.stringify(wrongIds)).catch(() => undefined);
    AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history)).catch(() => undefined);
  }, [hydrated, words, knownIds, wrongIds, history]);

  const currentQuestion = quiz?.[questionIndex];
  const currentAnswerIsCorrect = currentQuestion
    ? isFlexibleCorrectAnswer(answerText, currentQuestion.answer)
    : false;
  const knownCount = knownIds.filter((id) => words.some((word) => word.id === id)).length;
  const wrongWords = words.filter((word) => wrongIds.includes(word.id));
  const progress = quiz ? ((questionIndex + 1) / quiz.length) * 100 : 0;

  const sortedWords = useMemo(() => [...words].reverse(), [words]);

  function triggerHaptic() {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    }
  }

  function setActiveMode(nextMode: Mode) {
    triggerHaptic();
    setMode(nextMode);
    setMenuOpen(false);
    setFeedback("");
  }

  function showToast(message: string) {
    const id = Date.now() + Math.random();
    setToastMessages((previous) => [...previous, { id, message }]);
    Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    setTimeout(() => {
      setToastMessages((previous) => {
        const next = previous.filter((toast) => toast.id !== id);
        if (!next.length) Animated.timing(toastOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start();
        return next;
      });
    }, 2200);
  }

  function startDownloadToast(label: string) {
    const id = Date.now() + Math.random();
    progressToastIdRef.current = id;
    setToastMessages((previous) => [...previous, { id, message: `${label} 다운로드 중... 0%` }]);
    Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    return id;
  }

  function updateDownloadToast(id: number, message: string) {
    setToastMessages((previous) => previous.map((toast) => (toast.id === id ? { ...toast, message } : toast)));
  }

  function finishDownloadToast(id: number, label: string) {
    updateDownloadToast(id, `${label}가 다운로드 되었습니다.`);
    setTimeout(() => {
      setToastMessages((previous) => {
        const next = previous.filter((toast) => toast.id !== id);
        if (!next.length) Animated.timing(toastOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start();
        return next;
      });
    }, 2200);
  }

  function buildPdfQuestions(sourceWords: Word[]): PdfQuestion[] {
    const orderedWords = orderType === "random"
      ? [...sourceWords].sort((left, right) => {
          const leftKey = `${left.id}:${left.term}`.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0);
          const rightKey = `${right.id}:${right.term}`.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0);
          return leftKey - rightKey;
        })
      : sourceWords;

    return orderedWords.map((word, index) => {
      const direction = questionType === "mix"
        ? (index % 2 === 0 ? "engkor" : "koreng")
        : questionType;
      return direction === "engkor"
        ? { prompt: word.term, answer: word.meaning }
        : { prompt: word.meaning, answer: word.term };
    });
  }

  async function downloadPdfFile(kind: "exam" | "answer", label: "시험지" | "답안지") {
    if (kind === "answer" && (await AsyncStorage.getItem(PDF_EXAM_CREATED_KEY)) !== "true") {
      showToast("시험지를 먼저 다운로드해 주세요.");
      setGradeFeedback("답안지를 만들기 전에 시험지를 먼저 다운로드해 주세요.");
      return;
    }

    const parsed = parseWords(worksheetInput);
    if (!parsed.words.length) {
      setGradeFeedback("시험지에 넣을 단어를 먼저 입력해 주세요.");
      return;
    }

    const progressToastId = startDownloadToast(label);
    let currentPercent = 0;

    const timer = setInterval(() => {
      currentPercent += 1;
      if (currentPercent < 98) {
        updateDownloadToast(progressToastId, `${label} 다운로드 중... ${currentPercent}%`);
      }
    }, 25);

    try {
      const questions = buildPdfQuestions(parsed.words);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const base64 = kind === "exam"
        ? await createExamPdf(questions)
        : await createAnswerPdf(questions.map((question) => question.answer));

      clearInterval(timer);
      updateDownloadToast(progressToastId, `${label} 다운로드 중... 100%`);

      await savePdfBase64(base64, `vocab-pocket-${label}-${Date.now()}.pdf`);
      if (kind === "exam") await AsyncStorage.setItem(PDF_EXAM_CREATED_KEY, "true");

      finishDownloadToast(progressToastId, label);
      setGradeFeedback(`${label}를 저장했습니다.`);
    } catch (fallbackError) {
      clearInterval(timer);
      updateDownloadToast(progressToastId, `${label} 다운로드에 실패했습니다.`);
      console.error("Direct PDF download failed", fallbackError);
      setGradeFeedback("PDF 저장에 실패했습니다. 파일 권한을 확인하고 다시 시도해 주세요.");
    }
  }

  async function savePdfBase64(base64: string, fileName: string) {
    if (Platform.OS === "web") {
      const binary = globalThis.atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (Platform.OS === "android" && FileSystem.StorageAccessFramework) {
      const getDirectoryUri = async () => {
        const savedDirectoryUri = await AsyncStorage.getItem(PDF_DIRECTORY_KEY);
        if (savedDirectoryUri) return savedDirectoryUri;
        const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permission.granted) return null;
        await AsyncStorage.setItem(PDF_DIRECTORY_KEY, permission.directoryUri);
        return permission.directoryUri;
      };

      if (!directoryPermissionRef.current) {
        directoryPermissionRef.current = getDirectoryUri().finally(() => {
          directoryPermissionRef.current = null;
        });
      }
      const directoryUri = await directoryPermissionRef.current;
      if (directoryUri) {
        try {
          const targetUri = await FileSystem.StorageAccessFramework.createFileAsync(directoryUri, fileName, "application/pdf");
          await FileSystem.writeAsStringAsync(targetUri, base64, { encoding: FileSystem.EncodingType.Base64 });
          return;
        } catch (error) {
          await AsyncStorage.removeItem(PDF_DIRECTORY_KEY);
          throw error;
        }
      }
    }

    const cacheUri = `${FileSystem.cacheDirectory}${fileName}`;
    await FileSystem.writeAsStringAsync(cacheUri, base64, { encoding: FileSystem.EncodingType.Base64 });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(cacheUri, { mimeType: "application/pdf", dialogTitle: "PDF 저장" });
      return;
    }
    throw new Error("No native PDF save destination available");
  }

  function downloadExamPdf() {
    return downloadPdfFile("exam", "시험지");
  }

  function downloadAnswerPdf() {
    return downloadPdfFile("answer", "답안지");
  }

  async function pickAnswerPdf() {
    if (gradingStage !== "idle") return;

    setGradingStage("reading");

    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (picked.canceled) {
        setGradingStage("idle");
        return;
      }

      const asset = picked.assets[0];
      setUploadedAnswerName(asset.name);
      const pickedFile = "file" in asset ? asset.file : undefined;

      const parsed = parseWords(worksheetInput);
      if (!parsed.words.length) {
        setGradeFeedback("자동채점할 시험지 단어를 먼저 입력해 주세요.");
        return;
      }

      setGradeSummary(null);
      setGradeFeedback("PDF 파일을 읽는 중이에요...");

            setGradeFeedback("PDF 파일을 서버에 업로드하는 중이에요...");

      const apiBaseUrl = getApiBaseUrl() || "https://vocab-pocket.onrender.com";
      const uploadUrl = `${apiBaseUrl}/api/worksheet/upload-pdf`;

      setGradeFeedback("자동채점 서버를 확인하는 중이에요...");
      await waitForServerReady(apiBaseUrl);

      let storageKey = "";

      if (Platform.OS === "web" && pickedFile) {
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/pdf",
          },
          body: pickedFile as Blob,
        });

        if (!uploadResponse.ok) {
          const message = await uploadResponse.text().catch(() => "");
          throw new Error(
            `PDF 업로드 실패 (${uploadResponse.status}): ${message || "서버가 요청을 거부했습니다."}`,
          );
        }

        const uploadResult = (await uploadResponse.json()) as { key: string };
        storageKey = uploadResult.key;
      } else {
        const uploadResult = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            "Content-Type": "application/pdf",
          },
        });

        if (uploadResult.status < 200 || uploadResult.status >= 300) {
          throw new Error(
            `PDF 업로드 실패 (${uploadResult.status}): ${uploadResult.body || "서버가 요청을 거부했습니다."}`,
          );
        }

        const result = JSON.parse(uploadResult.body) as { key: string };
        storageKey = result.key;
      }

      if (!storageKey) {
        throw new Error("PDF 업로드 결과에서 저장 경로를 받지 못했습니다.");
      }

      setGradingStage("grading");
      setGradeFeedback("PDF 업로드가 완료됐어요. AI가 답안을 채점하는 중이에요...");

      const result = await waitWithTimeout(
        gradePdfMutation.mutateAsync({
          storageKey,
          words: parsed.words,
        }),
        300000,
      );
      const results = result.results;
      setGradeSummary({
        results,
        score: results.filter((item) => item.correct).length,
        total: results.length,
      });
      setGradeFeedback(`AI가 ${results.length}개 문제를 분석해 자동채점했습니다.`);
    } catch (error: any) {
      console.error("PDF 분석 상세 에러:", error);
      const message = error?.message || JSON.stringify(error);
      setGradeFeedback(message);
      Alert.alert("PDF 분석 실패", message);
    } finally {
      setGradingStage("idle");
    }
  }

  function startQuiz(sourceWords: Word[] = words) {
    if (!sourceWords.length) {
      setActiveMode("add");
      showToast("먼저 단어를 추가해 주세요");
      return;
    }

    const requestedCount = Number.parseInt(countText, 10);
    const count = Number.isFinite(requestedCount) && requestedCount > 0
        ? Math.min(requestedCount, sourceWords.length)
        : sourceWords.length;
    const selectedWords = orderType === "random" ? shuffle(sourceWords).slice(0, count) : sourceWords.slice(0, count);
    const nextQuiz = selectedWords.map((word) => {
      const direction = questionType === "mix"
        ? (Math.random() > 0.5 ? "engkor" : "koreng")
        : questionType;
      return {
        word,
        direction,
        question: direction === "engkor" ? word.term : word.meaning,
        answer: direction === "engkor" ? word.meaning : word.term,
      };
    });

    triggerHaptic();
    setQuiz(nextQuiz);
    setLastQuiz(nextQuiz);
    setQuestionIndex(0);
    setQuizScore(0);
    setAnswerText("");
    setRevealed(false);
    setQuizSummary(null);
    setShowAnswerKey(false);
    setFeedback("");
  }

  function goToNextQuestion(markKnown: boolean) {
    if (!quiz || !currentQuestion) return;

    if (markKnown) {
      setKnownIds((previous) => (previous.includes(currentQuestion.word.id) ? previous : [...previous, currentQuestion.word.id]));
      setWrongIds((previous) => previous.filter((id) => id !== currentQuestion.word.id));
    } else {
      setWrongIds((previous) => (previous.includes(currentQuestion.word.id) ? previous : [...previous, currentQuestion.word.id]));
    }

    const nextScore = quizScore + (markKnown ? 1 : 0);
    if (questionIndex >= quiz.length - 1) {
      setQuizScore(nextScore);
      setQuizSummary({ score: nextScore, total: quiz.length });
      setQuiz(null);
      setAnswerText("");
      setRevealed(false);
      triggerHaptic();
      return;
    }

    setQuizScore(nextScore);
    setQuestionIndex((previous) => previous + 1);
    setAnswerText("");
    setRevealed(false);
  }

  function addWords() {
    const parsed = parseWords(inputText);
    if (!parsed.words.length) {
      setFeedback("영어: 뜻 형식으로 단어를 한 줄에 하나씩 입력해 주세요.");
      return;
    }

    const existing = new Set(words.map((word) => word.term.toLowerCase()));
    const newWords = parsed.words.filter((word) => !existing.has(word.term.toLowerCase()));
    if (!newWords.length) {
      setFeedback("새로 추가할 단어가 없습니다. 이미 저장된 단어인지 확인해 주세요.");
      return;
    }

    setWords((previous) => [...previous, ...newWords]);
    setHistory((previous) => [
      ...previous,
      ...newWords.map((word, index) => ({ ...word, addedAt: Date.now() + index })),
    ]);
    setInputText("");
    const invalidMessage = parsed.invalidLines.length ? ` ${parsed.invalidLines.join(", ")}은 건너뛰었습니다.` : "";
    setFeedback(`${newWords.length}개 단어를 저장했습니다.${invalidMessage}`);
    triggerHaptic();
  }

  function removeWord(word: Word) {
    Alert.alert("단어 삭제", `“${word.term}”을(를) 단어장에서 삭제할까요?`, [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: () => {
          setWords((previous) => previous.filter((item) => item.id !== word.id));
          setKnownIds((previous) => previous.filter((id) => id !== word.id));
          setWrongIds((previous) => previous.filter((id) => id !== word.id));
          setHistory((previous) => previous.map((entry) => entry.id === word.id ? { ...entry, deletedAt: Date.now() } : entry));
        },
      },
    ]);
  }

  function removeAllWords() {
    if (!words.length) return;
    Alert.alert("전체 단어 삭제", "단어장에 있는 모든 단어를 삭제하시겠습니까? (기록에서 다시 추가할 수 있습니다.)", [
      { text: "취소", style: "cancel" },
      {
        text: "전체 삭제",
        style: "destructive",
        onPress: () => {
          const removedIds = new Set(words.map((w) => w.id));
          setWords([]);
          setKnownIds([]);
          setWrongIds([]);
          setHistory((previous) =>
            previous.map((entry) => (removedIds.has(entry.id) ? { ...entry, deletedAt: Date.now() } : entry))
          );
          showToast("모든 단어가 삭제되었습니다.");
        },
      },
    ]);
  }

  function restoreWordFromHistory(item: WordHistory) {
    const exists = words.some((word) => word.id === item.id || word.term.toLowerCase() === item.term.toLowerCase());
    if (exists) {
      showToast(`“${item.term}”은(는) 이미 단어장에 존재합니다.`);
      return;
    }

    const restoredWord: Word = {
      id: item.id,
      term: item.term,
      meaning: item.meaning,
    };

    setWords((previous) => [...previous, restoredWord]);
    setHistory((previous) =>
      previous.map((entry) => (entry.id === item.id ? { ...entry, deletedAt: undefined } : entry))
    );
    showToast(`“${item.term}”을(를) 단어장에 다시 추가했습니다.`);
    triggerHaptic();
  }

  function renderHeader() {
    return (
      <View style={styles.headerRow}>
        <View style={styles.brandRow}>
          <View style={[styles.logo, { backgroundColor: colors.primary }]}>
            <Text style={styles.logoText}>V</Text>
          </View>
          <View>
            <Text style={[styles.brand, { color: colors.foreground }]}>Vocab Pocket</Text>
            <Text style={[styles.brandCaption, { color: colors.muted }]}>오늘도 한 단어씩</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => setMenuOpen((previous) => !previous)} style={({ pressed }) => [styles.menuButton, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
            <Text style={[styles.menuButtonText, { color: colors.foreground }]}>☰</Text>
          </Pressable>
          <View style={[styles.statusPill, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
            <View style={[styles.statusDot, { backgroundColor: colors.success }]} />
            <Text style={[styles.statusText, { color: colors.muted }]}>기기에 저장됨</Text>
          </View>
        </View>
      </View>
    );
  }

  function renderMenu() {
    if (!menuOpen) return null;
    return (
      <View style={[styles.menuPanel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.menuTitle, { color: colors.muted }]}>학습 도구</Text>
        <Pressable onPress={() => setActiveMode("worksheet")} style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
          <Text style={[styles.menuItemTitle, { color: colors.foreground }]}>시험지</Text>
          <Text style={[styles.menuItemSubtitle, { color: colors.muted }]}>단어를 입력하고 시험지 만들기</Text>
        </Pressable>
        <Pressable onPress={() => setActiveMode("answer")} style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
          <Text style={[styles.menuItemTitle, { color: colors.foreground }]}>답안지</Text>
          <Text style={[styles.menuItemSubtitle, { color: colors.muted }]}>PDF 업로드 후 자동채점</Text>
        </Pressable>
      </View>
    );
  }

 function renderTopArea() {
  return (
    <View style={{ gap: 12 }}>
      <View
        style={{
          backgroundColor: "#EFF6FF",
          paddingVertical: 6,
          alignItems: "center",
          borderRadius: 8,
        }}
      >
        <Text style={{ color: "#2563EB", fontSize: 12, fontWeight: "bold" }}>
          ✅ [EAS Update (v{Constants.expoConfig?.version || "1.0.6"}) 적용됨]
        </Text>
      </View>

      {renderHeader()}
      {renderMenu()}
      {renderTabs()}
    </View>
  );
}


  function renderTabs() {
    return (
      <View style={[styles.segmentedControl, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {([
          ["practice", "연습"],
          ["add", "단어 추가"],
          ["library", "단어장"],
          ["history", "기록"],
        ] as [Mode, string][]).map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setActiveMode(value)}
            style={({ pressed }) => [
              styles.segment,
              mode === value && { backgroundColor: colors.foreground },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.segmentText, { color: mode === value ? colors.background : colors.muted }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  function renderStats() {
    return (
      <View style={[styles.statsCard, { backgroundColor: colors.primary }]}>
        <View style={styles.statsIntro}>
          <Text style={styles.statsEyebrow}>MY VOCABULARY</Text>
          <Text style={styles.statsTitle}>작은 복습이{`\n`}큰 실력을 만들어요.</Text>
          <Text style={styles.statsSubtext}>저장한 단어를 나만의 속도로 연습해 보세요.</Text>
        </View>
        <View style={styles.statsDivider} />
        <View style={styles.statsNumbers}>
          <View>
            <Text style={styles.statsNumber}>{words.length}</Text>
            <Text style={styles.statsLabel}>전체 단어</Text>
          </View>
          <View>
            <Text style={styles.statsNumber}>{knownCount}</Text>
            <Text style={styles.statsLabel}>학습 완료</Text>
          </View>
        </View>
      </View>
    );
  }

  function renderOptionChip(label: string, selected: boolean, onPress: () => void) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.optionChip,
          { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primarySoft : colors.surface },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.optionChipText, { color: selected ? colors.primary : colors.foreground }]}>{label}</Text>
      </Pressable>
    );
  }

  function renderPractice() {
    if (quiz && currentQuestion) {
      return (
        <View style={styles.sectionGap}>
          <View style={styles.quizTopRow}>
            <Pressable onPress={() => setQuiz(null)} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
              <Text style={[styles.backButtonText, { color: colors.muted }]}>‹  처음으로</Text>
            </Pressable>
            <Text style={[styles.quizCount, { color: colors.muted }]}>{questionIndex + 1} / {quiz.length}</Text>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: colors.primary }]} />
          </View>
          <View style={[styles.questionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.questionDirection, { color: colors.primary }]}>{currentQuestion.direction === "engkor" ? "영어를 보고 뜻을 떠올려 보세요" : "뜻을 보고 영어를 떠올려 보세요"}</Text>
            <Text style={[styles.questionText, { color: colors.foreground }]}>{currentQuestion.question}</Text>
            <Text style={[styles.answerHint, { color: colors.muted }]}>정답을 입력하거나, 바로 확인하세요.</Text>
            <TextInput
              value={answerText}
              onChangeText={setAnswerText}
              editable={!revealed}
              placeholder={currentQuestion.direction === "engkor" ? "한글 뜻 입력" : "영어 단어 입력"}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              returnKeyType="done"
              style={[styles.answerInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            />
            {!revealed ? (
              <Pressable onPress={() => { setRevealed(true); triggerHaptic(); }} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.foreground }, pressed && styles.pressed]}>
                <Text style={[styles.primaryButtonText, { color: colors.background }]}>정답 보기</Text>
              </Pressable>
            ) : (
              <View style={[styles.answerReveal, { backgroundColor: currentAnswerIsCorrect ? colors.successSoft : colors.warningSoft }]}>
                <Text style={[styles.revealLabel, { color: currentAnswerIsCorrect ? colors.success : colors.warning }]}>
                  {answerText.trim() ? (currentAnswerIsCorrect ? "정답이에요" : "정답을 확인해 보세요") : "스스로 답을 떠올렸는지 체크해 보세요"}
                </Text>
                <Text style={[styles.revealAnswer, { color: colors.foreground }]}>{currentQuestion.answer}</Text>
              </View>
            )}
          </View>
          {revealed && (
            <View style={styles.nextActions}>
              {currentAnswerIsCorrect ? (
                /* ✨ 정답일 때: "계속"과 "다시 학습" 둘 다 표시 */
                <>
                  <Pressable
                    onPress={() => goToNextQuestion(true)}
                    style={({ pressed }) => [styles.primaryButton, styles.flexButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}
                  >
                    <Text style={styles.primaryButtonText}>계속</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => goToNextQuestion(false)}
                    style={({ pressed }) => [styles.secondaryButton, styles.flexButton, { borderColor: colors.border, backgroundColor: colors.surface }, pressed && styles.pressed]}
                  >
                    <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>다시 학습</Text>
                  </Pressable>
                </>
              ) : (
                /* ✨ 오답일 때: "다시 학습" 단독 표시 */
                <Pressable
                  onPress={() => goToNextQuestion(false)}
                  style={({ pressed }) => [styles.secondaryButton, styles.flexButton, { borderColor: colors.warning || "#F59E0B", backgroundColor: colors.warningSoft || "#FEF3C7" }, pressed && styles.pressed]}
                >
                  <Text style={[styles.secondaryButtonText, { color: colors.warning || "#D97706" }]}>다시 학습</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      );
    }

    if (quizSummary) {
      const percentage = Math.round((quizSummary.score / quizSummary.total) * 100);
      return (
        <View style={styles.sectionGap}>
          <View style={[styles.summaryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.summaryEyebrow, { color: colors.primary }]}>SESSION COMPLETE</Text>
            <Text style={[styles.summaryTitle, { color: colors.foreground }]}>연습을 끝냈어요.</Text>
            <Text style={[styles.summaryDescription, { color: colors.muted }]}>오늘도 꾸준히 해낸 나를 칭찬해 주세요.</Text>
            <View style={styles.scoreRow}>
              <Text style={[styles.scoreNumber, { color: colors.foreground }]}>{quizSummary.score}</Text>
              <Text style={[styles.scoreTotal, { color: colors.muted }]}>/ {quizSummary.total} 정답</Text>
              <Text style={[styles.scorePercent, { color: colors.success }]}>{percentage}%</Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View style={[styles.progressFill, { width: `${percentage}%`, backgroundColor: colors.success }]} />
            </View>
          </View>
          <View style={styles.nextActions}>
            <Pressable onPress={() => setQuizSummary(null)} style={({ pressed }) => [styles.primaryButton, styles.flexButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}>
              <Text style={styles.primaryButtonText}>처음으로</Text>
            </Pressable>
            <Pressable onPress={() => setShowAnswerKey((previous) => !previous)} style={({ pressed }) => [styles.secondaryButton, styles.flexButton, { borderColor: colors.border, backgroundColor: colors.surface }, pressed && styles.pressed]}>
              <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>{showAnswerKey ? "정답지 닫기" : "정답지 보기"}</Text>
            </Pressable>
          </View>
          {showAnswerKey && (
            <View style={[styles.answerKey, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>이번 세트 정답</Text>
              {lastQuiz.map((item, index) => (
                <View key={`${item.word.id}-${index}`} style={[styles.answerKeyRow, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.answerKeyNumber, { color: colors.muted }]}>{String(index + 1).padStart(2, "0")}</Text>
                  <Text style={[styles.answerKeyQuestion, { color: colors.muted }]}>{item.question}</Text>
                  <Text style={[styles.answerKeyAnswer, { color: colors.foreground }]}>{item.answer}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      );
    }

    return (
      <View style={styles.sectionGap}>
        <View style={styles.sectionHeading}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>오늘의 연습</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>원하는 방식으로 시험지를 만들어 보세요.</Text>
          </View>
          <Text style={[styles.wordCountBadge, { color: colors.primary, backgroundColor: colors.primarySoft }]}>{words.length} words</Text>
        </View>
        <View style={[styles.settingsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.muted }]}>문제 유형</Text>
          <View style={styles.chipRow}>
            {renderOptionChip(QUESTION_TYPE_LABELS.engkor, questionType === "engkor", () => setQuestionType("engkor"))}
            {renderOptionChip(QUESTION_TYPE_LABELS.koreng, questionType === "koreng", () => setQuestionType("koreng"))}
            {renderOptionChip(QUESTION_TYPE_LABELS.mix, questionType === "mix", () => setQuestionType("mix"))}
          </View>
          <Text style={[styles.cardLabel, { color: colors.muted }]}>문제 순서</Text>
          <View style={styles.chipRow}>
            {renderOptionChip(ORDER_LABELS.normal, orderType === "normal", () => setOrderType("normal"))}
            {renderOptionChip(ORDER_LABELS.random, orderType === "random", () => setOrderType("random"))}
          </View>
          <Text style={[styles.cardLabel, { color: colors.muted }]}>문제 개수</Text>
          <View style={styles.countRow}>
            <TextInput
              value={countText}
              onChangeText={setCountText}
              placeholder={`전체 ${words.length}개`}
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              style={[styles.countInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            />
            <Text style={[styles.countHint, { color: colors.muted }]}>비워두면 전체 단어를 사용해요.</Text>
          </View>
          <Pressable onPress={() => startQuiz()} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.foreground }, pressed && styles.pressed]}>
            <Text style={[styles.primaryButtonText, { color: colors.background }]}>시험 시작하기  →</Text>
          </Pressable>
        </View>
        <View style={[styles.tipCard, { backgroundColor: colors.primarySoft }]}>
          <Text style={[styles.tipIcon, { color: colors.primary }]}>✦</Text>
          <View style={styles.tipCopy}>
            <Text style={[styles.tipTitle, { color: colors.foreground }]}>기억을 오래 남기는 방법</Text>
            <Text style={[styles.tipText, { color: colors.muted }]}>틀린 단어는 ‘다시 학습’으로 표시하고 잠시 후 한 번 더 복습해 보세요.</Text>
          </View>
        </View>
      </View>
    );
  }

  function renderAddWords() {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: 16 }]}>
          <View style={styles.sectionHeading}>
            <View>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>단어 추가</Text>
              <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>영어와 뜻을 한 줄씩 입력해 주세요.</Text>
            </View>
            <Text style={[styles.wordCountBadge, { color: colors.primary, backgroundColor: colors.primarySoft }]}>{words.length} words</Text>
          </View>
          <View style={[styles.settingsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardLabel, { color: colors.muted }]}>입력 형식</Text>
            <View style={[styles.formatExample, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={[styles.formatText, { color: colors.foreground }]}>curious: 호기심이 많은</Text>
              <Text style={[styles.formatText, { color: colors.muted }]}>journey: 여행, 여정</Text>
              <Text style={[styles.formatText, { color: colors.muted }]}>improve: 향상시키다</Text>
            </View>
            <TextInput
              value={inputText}
              onChangeText={setInputText}
              multiline
              textAlignVertical="top"
              placeholder="영어: 뜻 형식으로 입력하세요"
              placeholderTextColor={colors.muted}
              style={[styles.bulkInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            />
            <Pressable onPress={addWords} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}>
              <Text style={styles.primaryButtonText}>단어 저장하기</Text>
            </Pressable>
            {feedback ? <Text style={[styles.feedback, { color: colors.primary }]}>{feedback}</Text> : null}
          </View>
          <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>이렇게 사용할 수 있어요</Text>
            <Text style={[styles.infoText, { color: colors.muted }]}>• 콜론(:) 기준으로 영어와 뜻을 나눠요.</Text>
            <Text style={[styles.infoText, { color: colors.muted }]}>• 빈 줄은 자동으로 무시해요.</Text>
            <Text style={[styles.infoText, { color: colors.muted }]}>• 같은 영어 단어는 중복 저장하지 않아요.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  function renderLibrary() {
    return (
      <FlatList
        data={sortedWords}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.libraryContent}
        ListHeaderComponent={
          <>
          <View style={styles.libraryHeader}>
            <View style={styles.sectionHeading}>
              <View>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>내 단어장</Text>
                <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>저장한 단어를 한눈에 확인해요.</Text>
              </View>
              <Text style={[styles.wordCountBadge, { color: colors.primary, backgroundColor: colors.primarySoft }]}>{words.length} words</Text>
            </View>
            <View style={[styles.librarySummary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View>
                <Text style={[styles.librarySummaryNumber, { color: colors.foreground }]}>{knownCount}</Text>
                <Text style={[styles.librarySummaryLabel, { color: colors.muted }]}>학습 완료</Text>
              </View>
              <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />
              <View>
                <Text style={[styles.librarySummaryNumber, { color: wrongWords.length ? colors.warning : colors.foreground }]}>{wrongWords.length}</Text>
                <Text style={[styles.librarySummaryLabel, { color: colors.muted }]}>오답 복습</Text>
              </View>
              <Pressable onPress={() => setActiveMode("add")} style={({ pressed }) => [styles.smallButton, { backgroundColor: colors.primarySoft }, pressed && styles.pressed]}>
                <Text style={[styles.smallButtonText, { color: colors.primary }]}>+ 추가</Text>
              </Pressable>
            </View>

            {words.length > 0 && (
              <Pressable
                onPress={removeAllWords}
                style={({ pressed }) => [styles.deleteAllButton, { backgroundColor: colors.errorSoft || "#FEE2E2", borderColor: colors.error || "#EF4444" }, pressed && styles.pressed]}
              >
                <Text style={[styles.deleteAllButtonText, { color: colors.error || "#DC2626" }]}>단어 일괄 삭제 ({words.length})</Text>
              </Pressable>
            )}

            <Pressable
              disabled={!wrongWords.length}
              onPress={() => { setActiveMode("practice"); startQuiz(wrongWords); }}
              style={({ pressed }) => [styles.reviewButton, { backgroundColor: wrongWords.length ? colors.warningSoft : colors.surface, borderColor: wrongWords.length ? colors.warning : colors.border }, !wrongWords.length && styles.disabledButton, pressed && styles.pressed]}
            >
              <View style={styles.reviewButtonCopy}>
                <Text style={[styles.reviewButtonTitle, { color: wrongWords.length ? colors.warning : colors.muted }]}>틀린 단어 복습하기</Text>
                <Text style={[styles.reviewButtonSubtitle, { color: colors.muted }]}>{wrongWords.length ? `${wrongWords.length}개 단어를 다시 풀어볼까요?` : "퀴즈에서 ‘다시 학습’을 누르면 여기에 모여요."}</Text>
              </View>
              <Text style={[styles.reviewButtonArrow, { color: wrongWords.length ? colors.warning : colors.muted }]}>→</Text>
            </Pressable>
            <Text style={[styles.listHeading, { color: colors.muted }]}>최근 추가한 단어</Text>
          </View>
          </>
        }
        ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.muted }]}>아직 저장된 단어가 없어요.</Text>}
        renderItem={({ item, index }) => (
          <View style={[styles.wordRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.wordIndex, { backgroundColor: colors.background }]}>
              <Text style={[styles.wordIndexText, { color: colors.muted }]}>{String(sortedWords.length - index).padStart(2, "0")}</Text>
            </View>
            <View style={styles.wordCopy}>
              <Text style={[styles.wordTerm, { color: colors.foreground }]}>{item.term}</Text>
              <Text style={[styles.wordMeaning, { color: colors.muted }]}>{item.meaning}</Text>
            </View>
            {knownIds.includes(item.id) ? <Text style={[styles.knownMark, { color: colors.success }]}>✓</Text> : null}
            <Pressable onPress={() => removeWord(item)} style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}>
              <Text style={[styles.removeButtonText, { color: colors.muted }]}>×</Text>
            </Pressable>
          </View>
        )}
      />
    );
  }

  function renderHistory() {
    const historyItems = [...history].sort((a, b) => b.addedAt - a.addedAt);
    return (
      <FlatList
        data={historyItems}
        keyExtractor={(item) => `${item.id}-${item.addedAt}`}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.libraryContent}
        ListHeaderComponent={
          <>
          <View style={styles.libraryHeader}>
            <View style={styles.sectionHeading}>
              <View>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>단어 기록</Text>
                <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>삭제된 모든 단어를 시간순으로 보관해요.</Text>
              </View>
              <Text style={[styles.wordCountBadge, { color: colors.primary, backgroundColor: colors.primarySoft }]}>{historyItems.length} records</Text>
            </View>
            <View style={[styles.historyNotice, { backgroundColor: colors.primarySoft }]}>
              <Text style={[styles.tipIcon, { color: colors.primary }]}>↺</Text>
              <Text style={[styles.historyNoticeText, { color: colors.muted }]}>삭제된 단어는 버튼을 눌러 다시 단어장에 추가할 수 있습니다.</Text>
            </View>
            <Text style={[styles.listHeading, { color: colors.muted }]}>전체 추가 기록</Text>
          </View>
          </>
        }
        ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.muted }]}>아직 추가한 단어 기록이 없어요.</Text>}
        renderItem={({ item }) => {
          const isDeletedInLibrary = !!item.deletedAt;
          return (
            <View style={[styles.wordRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.wordIndex, { backgroundColor: colors.background }]}>
                <Text style={[styles.wordIndexText, { color: colors.muted }]}>↗</Text>
              </View>
              <View style={styles.wordCopy}>
                <Text style={[styles.wordTerm, { color: colors.foreground }]}>{item.term}</Text>
                <Text style={[styles.wordMeaning, { color: colors.muted }]}>{item.meaning}</Text>
                <Text style={[styles.historyDate, { color: colors.muted }]}>{new Date(item.addedAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric" })}</Text>
              </View>
              {isDeletedInLibrary ? (
                <Pressable
                  onPress={() => restoreWordFromHistory(item)}
                  style={({ pressed }) => [styles.restoreButton, { backgroundColor: colors.primarySoft }, pressed && styles.pressed]}
                >
                  <Text style={[styles.restoreButtonText, { color: colors.primary }]}>다시 추가</Text>
                </Pressable>
              ) : (
                <Text style={[styles.historyStatus, { color: colors.success }]}>사용 중</Text>
              )}
            </View>
          );
        }}
      />
    );
  }

  function renderWorksheet() {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: 16}]} keyboardShouldPersistTaps="handled">
          <View style={styles.sectionHeading}>
            <View>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>시험지 만들기</Text>
              <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>단어를 입력하면 시험지와 답안지를 PDF로 만들어요.</Text>
            </View>
            <Text style={[styles.toolBadge, { color: colors.primary, backgroundColor: colors.primarySoft }]}>PDF</Text>
          </View>
          <View style={[styles.settingsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardLabel, { color: colors.muted }]}>시험 단어 입력</Text>
            <TextInput
              value={worksheetInput}
              onChangeText={(value) => { setWorksheetInput(value); setGradeSummary(null); }}
              multiline
              textAlignVertical="top"
              placeholder={"영어: 뜻 형식으로 입력하세요\nexample: 예시"}
              placeholderTextColor={colors.muted}
              style={[styles.bulkInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            />
            <Text style={[styles.cardLabel, { color: colors.muted }]}>문제 유형</Text>
            <View style={styles.chipRow}>
              {renderOptionChip("영어 → 한글", questionType === "engkor", () => setQuestionType("engkor"))}
              {renderOptionChip("한글 → 영어", questionType === "koreng", () => setQuestionType("koreng"))}
              {renderOptionChip("혼합", questionType === "mix", () => setQuestionType("mix"))}
            </View>
            <Text style={[styles.cardLabel, { color: colors.muted }]}>문제 순서</Text>
            <View style={styles.chipRow}>
              {renderOptionChip("입력 순서", orderType === "normal", () => setOrderType("normal"))}
              {renderOptionChip("랜덤", orderType === "random", () => setOrderType("random"))}
            </View>
            <Pressable onPress={() => setWorksheetInput(words.map((word) => `${word.term}: ${word.meaning}`).join("\n"))} style={({ pressed }) => [styles.secondaryButton, { borderColor: colors.border, backgroundColor: colors.background }, pressed && styles.pressed]}>
              <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>내 단어장에서 불러오기 ({words.length})</Text>
            </Pressable>
            <View style={styles.nextActions}>
              <Pressable onPress={downloadExamPdf} style={({ pressed }) => [styles.primaryButton, styles.flexButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}>
                <Text style={styles.primaryButtonText}>시험지 다운로드</Text>
              </Pressable>
              <Pressable onPress={downloadAnswerPdf} style={({ pressed }) => [styles.secondaryButton, styles.flexButton, { borderColor: colors.border, backgroundColor: colors.background }, pressed && styles.pressed]}>
                <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>답안지 다운로드</Text>
              </Pressable>
            </View>
            <Text style={[styles.helperText, { color: colors.muted }]}>답안지 탭으로 가면 PDF를 업로드해 자동채점할 수 있어요.</Text>
            {gradeFeedback ? <Text style={[styles.feedback, { color: colors.primary }]}>{gradeFeedback}</Text> : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  function renderAnswer() {
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: 16 }]}>
        <View style={styles.sectionHeading}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>답안지 자동채점</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>시험지 답안 PDF를 올리면 바로 채점해요.</Text>
          </View>
          <Text style={[styles.toolBadge, { color: colors.primary, backgroundColor: colors.primarySoft }]}>AUTO</Text>
        </View>
        <View style={[styles.settingsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.muted }]}>1. 시험지 단어 확인</Text>
          <Text style={[styles.infoText, { color: colors.muted }]}>시험지 탭에서 입력한 단어 기준으로 채점합니다. 입력 내용이 비어 있으면 먼저 시험지 탭에서 단어를 입력해 주세요.</Text>
          <Text style={[styles.cardLabel, { color: colors.muted }]}>2. 답안지 PDF 업로드</Text>
          <Pressable
            onPress={pickAnswerPdf}
            disabled={gradingStage !== "idle"}
            style={({ pressed }) => [
              styles.uploadBox,
              { borderColor: colors.primary, backgroundColor: colors.primarySoft },
              gradingStage !== "idle" && styles.disabledButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.uploadIcon, { color: colors.primary }]}>↑</Text>
            <Text style={[styles.uploadTitle, { color: colors.foreground }]}>{uploadedAnswerName || "PDF 파일 선택하기"}</Text>
            <Text style={[styles.uploadSubtitle, { color: colors.muted }]}>문제·인쇄 답안·손글씨를 AI가 자동 인식해요</Text>
          </Pressable>
          {gradingStage !== "idle" ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 2 }}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.feedback, { color: colors.primary, marginTop: 0 }]}>
                {gradingStage === "reading" ? "PDF 파일을 읽는 중이에요..." : "AI가 답안을 채점하는 중이에요..."}
              </Text>
            </View>
          ) : null}
          {gradeFeedback ? <Text style={[styles.feedback, { color: gradeSummary ? colors.success : colors.warning }]}>{gradeFeedback}</Text> : null}
        </View>
        {gradeSummary && (
          <View style={[styles.summaryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.summaryEyebrow, { color: colors.primary }]}>AUTO GRADE</Text>
            <Text style={[styles.summaryTitle, { color: colors.foreground }]}>{gradeSummary.score} / {gradeSummary.total} 정답</Text>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View style={[styles.progressFill, { width: `${gradeSummary.total ? (gradeSummary.score / gradeSummary.total) * 100 : 0}%`, backgroundColor: colors.success }]} />
            </View>
            {gradeSummary.results.map((result) => (
              <View key={result.number} style={[styles.gradeRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.gradeNumber, { color: colors.muted }]}>{result.number}.</Text>
                <Text style={[styles.gradeTerm, { color: colors.foreground }]}>{result.term}</Text>
                <View style={styles.gradeResultCopy}>
                  <Text style={[styles.gradeResult, { color: result.correct ? colors.success : colors.error }]}>{result.correct ? "정답" : `오답 · ${result.expected}`}</Text>
                  <Text style={[styles.gradeConfidence, { color: colors.muted }]}>인식 {Math.round(((result as typeof result & { confidence?: number }).confidence ?? 0) * 100)}%</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <ScreenContainer
      style={styles.flex}
      className="px-5"
      edges={["top", "left", "right"]}
    >
      <View>
        {renderTopArea()}
      </View>

      <View style={styles.flex}>
        {mode === "practice" ? (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.practiceContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={{ marginBottom: 24 }}>
              {renderStats()}
            </View>

            {renderPractice()}
          </ScrollView>
        ) : mode === "add" ? (
          renderAddWords()
        ) : mode === "library" ? (
          renderLibrary()
        ) : mode === "history" ? (
          renderHistory()
        ) : mode === 'worksheet' ? (
          renderWorksheet()
        ) : (
          renderAnswer()
        )}
      </View>

      {toastMessages.length ? (
        <Animated.View style={[styles.toastStack, { opacity: toastOpacity }]}>
          {toastMessages.map((toast) => (
            <View
              key={toast.id}
              style={[styles.toast, { backgroundColor: colors.foreground }]}
            >
              <Text style={[styles.toastText, { color: colors.background }]}>
                {toast.message}
              </Text>
            </View>
          ))}
        </Animated.View>
      ) : null}
    </ScreenContainer>
  );
}


const styles = StyleSheet.create({
  flex: { flex: 1 },
  toastStack: { position: "absolute", left: 24, right: 24, bottom: 76, gap: 8 },
  toast: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignItems: "center", shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  toastText: { fontSize: 12, fontWeight: "800" },
  pageContent: { paddingTop: 14, paddingBottom: 18, gap: 18 },
  practiceContent: { paddingTop: 16, paddingBottom: 118 },
  scrollContent: { paddingBottom: 20, gap: 18 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  menuButton: { width: 38, height: 38, borderRadius: 13, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  menuButtonText: { fontSize: 19, fontWeight: "700" },
  menuPanel: { borderRadius: 18, borderWidth: 1, padding: 8, gap: 3 },
  menuTitle: { fontSize: 10, fontWeight: "800", paddingHorizontal: 10, paddingTop: 5, paddingBottom: 3 },
  menuItem: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9 },
  menuItemTitle: { fontSize: 13, fontWeight: "800" },
  menuItemSubtitle: { fontSize: 10, marginTop: 3 },
  logo: { width: 38, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#FFFFFF", fontSize: 21, fontWeight: "800" },
  brand: { fontSize: 17, fontWeight: "800", letterSpacing: -0.3 },
  brandCaption: { fontSize: 11, marginTop: 1 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 20, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 10, fontWeight: "600" },
  segmentedControl: { flexDirection: "row", borderRadius: 14, borderWidth: 1, padding: 4 },
  segment: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 10, paddingVertical: 10 },
  segmentText: { fontSize: 12, fontWeight: "700" },
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  statsCard: { borderRadius: 24, padding: 20, minHeight: 174, overflow: "hidden" },
  statsIntro: { flex: 1 },
  statsEyebrow: { color: "rgba(255,255,255,0.72)", fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  statsTitle: { color: "#FFFFFF", fontSize: 25, lineHeight: 32, fontWeight: "800", letterSpacing: -0.8, marginTop: 8 },
  statsSubtext: { color: "rgba(255,255,255,0.76)", fontSize: 12, marginTop: 8 },
  statsDivider: { height: 1, backgroundColor: "rgba(255,255,255,0.2)", marginVertical: 17 },
  statsNumbers: { flexDirection: "row", gap: 28 },
  statsNumber: { color: "#FFFFFF", fontSize: 22, fontWeight: "800" },
  statsLabel: { color: "rgba(255,255,255,0.72)", fontSize: 11, marginTop: 2 },
  sectionGap: { gap: 16 },
  sectionHeading: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  sectionTitle: { fontSize: 21, fontWeight: "800", letterSpacing: -0.5 },
  sectionSubtitle: { fontSize: 12, marginTop: 5 },
  wordCountBadge: { borderRadius: 20, fontSize: 10, fontWeight: "800", overflow: "hidden", paddingHorizontal: 9, paddingVertical: 6 },
  toolBadge: { borderRadius: 20, fontSize: 10, fontWeight: "800", overflow: "hidden", paddingHorizontal: 9, paddingVertical: 6 },
  settingsCard: { borderRadius: 22, borderWidth: 1, padding: 16, gap: 12 },
  cardLabel: { fontSize: 11, fontWeight: "700", marginTop: 2 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 3 },
  optionChip: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  optionChipText: { fontSize: 12, fontWeight: "700" },
  countRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  countInput: { width: 112, height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 13, fontSize: 14, fontWeight: "700" },
  countHint: { flex: 1, fontSize: 11, lineHeight: 17 },
  primaryButton: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 4 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  secondaryButton: { minHeight: 48, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 4 },
  secondaryButtonText: { fontSize: 13, fontWeight: "800" },
  tipCard: { flexDirection: "row", gap: 11, borderRadius: 18, padding: 15 },
  tipIcon: { fontSize: 23, lineHeight: 25 },
  tipCopy: { flex: 1, gap: 3 },
  tipTitle: { fontSize: 12, fontWeight: "800" },
  tipText: { fontSize: 11, lineHeight: 17 },
  feedback: { fontSize: 12, lineHeight: 18, fontWeight: "700", marginTop: 2 },
  formatExample: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 5 },
  formatText: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
  bulkInput: { minHeight: 190, borderRadius: 14, borderWidth: 1, padding: 13, fontSize: 14, lineHeight: 22 },
  infoCard: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 8 },
  cardTitle: { fontSize: 14, fontWeight: "800", marginBottom: 3 },
  infoText: { fontSize: 12, lineHeight: 18 },
  helperText: { fontSize: 10, lineHeight: 15, textAlign: "center", marginTop: -3 },
  uploadBox: { minHeight: 132, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", alignItems: "center", justifyContent: "center", padding: 16, gap: 5 },
  uploadIcon: { fontSize: 28, fontWeight: "800" },
  uploadTitle: { fontSize: 13, fontWeight: "800", textAlign: "center" },
  uploadSubtitle: { fontSize: 10, textAlign: "center" },
  libraryContent: { paddingTop:16, paddingBottom: 34, gap: 10 },
  libraryHeader: { gap: 24, marginBottom: 5 },
  librarySummary: { flexDirection: "row", alignItems: "center", borderRadius: 18, borderWidth: 1, padding: 15, gap: 14 },
  librarySummaryNumber: { fontSize: 22, fontWeight: "800" },
  librarySummaryLabel: { fontSize: 11, marginTop: 2 },
  summaryDivider: { width: 1, height: 34 },
  smallButton: { marginLeft: "auto", borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10 },
  smallButtonText: { fontSize: 12, fontWeight: "800" },
  deleteAllButton: { borderRadius: 14, borderWidth: 1, paddingVertical: 12, alignItems: "center", justifyContent: "center" },
  deleteAllButtonText: { fontSize: 13, fontWeight: "800" },
  reviewButton: { flexDirection: "row", alignItems: "center", borderRadius: 16, borderWidth: 1, paddingHorizontal: 15, paddingVertical: 13 },
  reviewButtonCopy: { flex: 1, gap: 3 },
  reviewButtonTitle: { fontSize: 13, fontWeight: "800" },
  reviewButtonSubtitle: { fontSize: 11 },
  reviewButtonArrow: { fontSize: 22, fontWeight: "700", marginLeft: 10 },
  disabledButton: { opacity: 0.8 },
  historyNotice: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 16, padding: 14 },
  historyNoticeText: { flex: 1, fontSize: 11, lineHeight: 17 },
  historyDate: { fontSize: 10, marginTop: 2 },
  historyStatus: { fontSize: 10, fontWeight: "800" },
  restoreButton: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  restoreButtonText: { fontSize: 11, fontWeight: "800" },
  listHeading: { fontSize: 12, fontWeight: "700", marginTop: 1 },
  wordRow: { minHeight: 72, flexDirection: "row", alignItems: "center", borderRadius: 17, borderWidth: 1, padding: 11, gap: 11 },
  wordIndex: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  wordIndexText: { fontSize: 11, fontWeight: "800" },
  wordCopy: { flex: 1, gap: 3 },
  wordTerm: { fontSize: 15, fontWeight: "800" },
  wordMeaning: { fontSize: 12 },
  knownMark: { fontSize: 17, fontWeight: "800" },
  removeButton: { width: 28, height: 34, alignItems: "center", justifyContent: "center" },
  removeButtonText: { fontSize: 22, fontWeight: "300" },
  emptyText: { textAlign: "center", paddingVertical: 30, fontSize: 13 },
  quizTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  backButton: { paddingVertical: 4, paddingRight: 12 },
  backButtonText: { fontSize: 12, fontWeight: "700" },
  quizCount: { fontSize: 12, fontWeight: "800" },
  progressTrack: { height: 6, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  questionCard: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 13 },
  questionDirection: { fontSize: 11, fontWeight: "800" },
  questionText: { fontSize: 31, lineHeight: 38, fontWeight: "800", letterSpacing: -0.7, marginTop: 2 },
  answerHint: { fontSize: 12, lineHeight: 18 },
  answerInput: { height: 50, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, fontSize: 15 },
  answerReveal: { borderRadius: 14, padding: 14, gap: 4 },
  revealLabel: { fontSize: 11, fontWeight: "800" },
  revealAnswer: { fontSize: 18, fontWeight: "800" },
  nextActions: { flexDirection: "row", gap: 10 },
  flexButton: { flex: 1 },
  summaryCard: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 10 },
  summaryEyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  summaryTitle: { fontSize: 26, fontWeight: "800", letterSpacing: -0.7 },
  summaryDescription: { fontSize: 12 },
  scoreRow: { flexDirection: "row", alignItems: "baseline", marginTop: 12, gap: 5 },
  scoreNumber: { fontSize: 42, fontWeight: "900", letterSpacing: -1.5 },
  scoreTotal: { fontSize: 14, fontWeight: "700" },
  scorePercent: { fontSize: 14, fontWeight: "800", marginLeft: "auto" },
  answerKey: { borderRadius: 20, borderWidth: 1, padding: 15 },
  answerKeyRow: { flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, paddingVertical: 11 },
  answerKeyNumber: { width: 22, fontSize: 10, fontWeight: "800" },
  answerKeyQuestion: { flex: 1, fontSize: 12 },
  answerKeyAnswer: { maxWidth: "42%", fontSize: 12, fontWeight: "800", textAlign: "right" },
  gradeRow: { flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, paddingVertical: 10 },
  gradeNumber: { width: 22, fontSize: 11, fontWeight: "800" },
  gradeTerm: { flex: 1, fontSize: 13, fontWeight: "700" },
  gradeResultCopy: { maxWidth: "56%", alignItems: "flex-end", gap: 2 },
  gradeResult: { maxWidth: "56%", fontSize: 11, fontWeight: "700", textAlign: "right" },
  gradeConfidence: { fontSize: 9 },
});