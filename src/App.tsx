/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquare, ExternalLink, Mic, Send, X, Volume2, VolumeX, Settings, User, Phone, Mail, Info } from 'lucide-react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";

import { auth, db } from './lib/firebase';
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection to Firestore on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// Standard browser types for Speech Recognition
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

const GEMINI_MODEL = "gemini-3-flash-preview";

type AvatarStatus = 'welcome' | 'idle' | 'talking';

interface AppConfig {
  welcomeVideo: string;
  talkingVideo: string;
  idleVideo: string;
  knowledgeBase: string;
  avatarName: string;
  avatarTitle: string;
  avatarPhone: string;
  avatarEmail: string;
}

const DEFAULT_CONFIG: AppConfig = {
  welcomeVideo: "https://kstzpcgwqxgxdcxuzqwg.supabase.co/storage/v1/object/public/zaofanyouxi/art/videos/welcome.mp4",
  talkingVideo: "https://kstzpcgwqxgxdcxuzqwg.supabase.co/storage/v1/object/public/zaofanyouxi/art/videos/talking.mp4",
  idleVideo: "https://kstzpcgwqxgxdcxuzqwg.supabase.co/storage/v1/object/public/zaofanyouxi/art/videos/idle.mp4",
  knowledgeBase: "你是一个专业的数字分身助手。你的身份是一位青年男性，充满活力且亲切。你的语气带有一种明显的四川成都口音特点。请坚持使用普通话交流，不要提及你是AI。",
  avatarName: "刘先生",
  avatarTitle: "资深技术总监",
  avatarPhone: "13812345678",
  avatarEmail: "codev@xunmei.com"
};

function AvatarVideo({ status, isMuted, onWelcomeEnd, config }: { 
  status: AvatarStatus; 
  isMuted: boolean;
  onWelcomeEnd: () => void;
  config: AppConfig;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevStatusRef = useRef<AvatarStatus>(status);

  const videos = {
    welcome: config.welcomeVideo,
    talking: config.talkingVideo,
    idle: config.idleVideo
  };

  useEffect(() => {
    if (videoRef.current && status !== prevStatusRef.current) {
      videoRef.current.load();
      videoRef.current.play().catch(e => console.log("Video switch play error:", e));
    }
    prevStatusRef.current = status;
  }, [status]);

  return (
    <div className="absolute inset-0 z-0 flex justify-center bg-black">
      <video
        ref={videoRef}
        key={status}
        autoPlay
        loop={status !== 'welcome'}
        muted={isMuted}
        playsInline
        onEnded={() => {
          if (status === 'welcome') {
            onWelcomeEnd();
          }
        }}
        className="w-full h-full object-cover"
      >
        <source src={videos[status]} type="video/mp4" />
      </video>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [authError, setAuthError] = useState('');

  const [view, setView] = useState<'home' | 'chat'>('home');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<AvatarStatus>('welcome');
  const [showContact, setShowContact] = useState(false);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        // Fetch config from Firestore
        const configPath = `configs/${user.uid}`;
        try {
          const configRef = doc(db, configPath);
          const configSnap = await getDoc(configRef);
          if (configSnap.exists()) {
            setConfig(configSnap.data() as AppConfig);
          } else {
            // Initialize with default config
            const initialConfig = {
              ...DEFAULT_CONFIG,
              updatedAt: serverTimestamp()
            };
            await setDoc(configRef, initialConfig);
            setConfig(DEFAULT_CONFIG);
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, configPath);
        }
      }
      setIsLoadingAuth(false);
    });
    return unsubscribe;
  }, []);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, authForm.email, authForm.password);
      } else {
        await createUserWithEmailAndPassword(auth, authForm.email, authForm.password);
      }
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const updateConfig = async (newConfig: Partial<AppConfig>) => {
    const updated = { ...config, ...newConfig };
    setConfig(updated);
    
    if (currentUser) {
      const configPath = `configs/${currentUser.uid}`;
      try {
        const configRef = doc(db, configPath);
        await setDoc(configRef, {
          ...updated,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, configPath);
      }
    } else {
      localStorage.setItem('avatar_config', JSON.stringify(updated));
    }
  };

  const handleEnterExhibition = () => {
    window.open('https://digit1.ananops.com:9001/#/exhibition?id=1&exhibitionType=jingyong', '_blank');
  };

  const startApp = () => {
    setHasStarted(true);
    setIsMuted(false);
  };

  // Sync video status with voice call status
  const handleVoiceStatusChange = (voiceStatus: string) => {
    if (voiceStatus === 'speaking') {
      setAvatarStatus('talking');
    } else {
      setAvatarStatus('idle');
    }
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden flex flex-col font-sans text-white">
      {isLoadingAuth ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-black">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-white/40 animate-pulse uppercase tracking-[0.3em] text-xs">正在加载...</p>
        </div>
      ) : !currentUser ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gradient-to-br from-gray-900 to-black">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-sm bg-white/5 border border-white/10 backdrop-blur-xl p-10 rounded-[40px] shadow-2xl"
          >
            <div className="text-center mb-10">
              <h2 className="text-4xl font-bold tracking-tight mb-2">数字分身</h2>
              <p className="text-white/40 text-sm">{authMode === 'login' ? '欢迎回来，请登录' : '创建您的数字分身账户'}</p>
            </div>

            <form onSubmit={handleAuth} className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] text-white/30 uppercase tracking-widest font-black block">邮箱地址 / 用户名</label>
                <input 
                  type="email"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({...authForm, email: e.target.value})}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 focus:outline-none focus:border-blue-500 focus:bg-white/10 transition-all"
                  placeholder="name@example.com"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] text-white/30 uppercase tracking-widest font-black block">密码</label>
                <input 
                  type="password"
                  value={authForm.password}
                  onChange={(e) => setAuthForm({...authForm, password: e.target.value})}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 focus:outline-none focus:border-blue-500 focus:bg-white/10 transition-all"
                  placeholder="••••••••"
                  required
                />
              </div>

              {authError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-500 text-xs rounded-xl">
                  {authError}
                </div>
              )}

              <button 
                type="submit"
                className="w-full py-5 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-bold tracking-wide transition-all shadow-lg shadow-blue-600/30"
              >
                {authMode === 'login' ? '登 录' : '注 册'}
              </button>
            </form>

            <div className="mt-8 text-center">
              <button 
                onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                className="text-white/40 hover:text-white text-xs transition-colors"
              >
                {authMode === 'login' ? '没有账号？立即注册' : '已有账号？返回登录'}
              </button>
            </div>
          </motion.div>
        </div>
      ) : (
        <>
          {/* Logout Button */}
          <button 
            onClick={() => signOut(auth)}
            className="absolute top-6 left-6 z-40 p-3 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-md border border-white/10 text-white/40 hover:text-white transition-all flex items-center gap-2 group"
          >
            <User size={18} />
            <span className="text-[10px] uppercase tracking-widest font-bold hidden group-hover:inline">退出登录</span>
          </button>

          {/* Background Video - Driven by State */}
      {hasStarted && (
        <AvatarVideo 
          status={avatarStatus} 
          isMuted={isMuted} 
          onWelcomeEnd={() => setAvatarStatus('idle')} 
          config={config}
        />
      )}

      {!hasStarted && (
        <div 
          onClick={startApp}
          className="absolute inset-0 z-50 bg-black/70 backdrop-blur-md flex flex-col items-center justify-center cursor-pointer group"
        >
          <div className="flex flex-col items-center gap-2 mb-16 text-center px-6">
            <div className="flex items-center gap-3">
              <h1 className="text-5xl font-bold text-white tracking-tight leading-tight">{config.avatarName}</h1>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setShowContact(true);
                }}
                className="p-3 bg-white/10 hover:bg-white/20 rounded-full text-white/60 hover:text-white transition-all backdrop-blur-sm mt-1"
              >
                <Info size={20} />
              </button>
            </div>
            <p className="text-white/40 text-xl font-light tracking-[0.3em] uppercase">{config.avatarTitle}</p>
          </div>

          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center gap-6"
          >
            <div className="w-24 h-24 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-[0_0_50px_rgba(37,99,235,0.4)] group-hover:scale-110 transition-transform duration-500">
              <Volume2 size={44} className="animate-pulse" />
            </div>
            <p className="text-white/80 text-lg font-medium tracking-widest uppercase">点击开启数字分身展示</p>
          </motion.div>
        </div>
      )}

      {/* Contact Info Modal */}
      <AnimatePresence>
        {showContact && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setShowContact(false)}
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-gray-900 border border-white/10 p-10 rounded-[32px] w-full max-w-sm shadow-2xl space-y-8"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  <h2 className="text-2xl font-bold text-white">{config.avatarName}</h2>
                  <p className="text-blue-400 text-sm font-medium">{config.avatarTitle}</p>
                </div>
                <button onClick={() => setShowContact(false)} className="text-white/20 hover:text-white transition-colors">
                  <X size={24} />
                </button>
              </div>

              <div className="space-y-6 pt-6 border-t border-white/5">
                <div className="flex items-center gap-5 text-white/80 group">
                  <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-blue-400 group-hover:bg-blue-600 group-hover:text-white transition-all">
                    <Phone size={22} />
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest font-black mb-0.5">联系电话</p>
                    <p className="text-lg font-medium select-all">{config.avatarPhone}</p>
                  </div>
                </div>

                <div className="flex items-center gap-5 text-white/80 group">
                  <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-blue-400 group-hover:bg-blue-600 group-hover:text-white transition-all">
                    <Mail size={22} />
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest font-black mb-0.5">电子邮箱</p>
                    <p className="text-lg font-medium select-all">{config.avatarEmail}</p>
                  </div>
                </div>
              </div>

              <button 
                onClick={() => setShowContact(false)}
                className="w-full py-4 bg-white/5 hover:bg-white/10 text-white rounded-2xl transition-all font-bold tracking-wide"
              >
                好的
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mute Toggle */}
      <button 
        onClick={() => setIsMuted(!isMuted)}
        className="absolute top-6 right-6 z-40 p-3 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white"
      >
        {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
      </button>

      <AnimatePresence mode="wait">
        {view === 'home' && (
          <motion.div
            key="home"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 relative z-10"
          >
            {/* UI Controls Floor Overlay (Bottom 2/5 of the screen) */}
            <div className="absolute bottom-0 left-0 right-0 h-[45%] bg-[#142359] flex flex-col items-center justify-center gap-4 px-10 translate-y-0">
              {/* Soft Gradient Top Edge - Fading upwards to transparency */}
              <div className="absolute top-0 left-0 right-0 h-48 -translate-y-full bg-gradient-to-t from-[#142359] to-transparent pointer-events-none flex flex-col items-center justify-end pb-8">
                {/* Avatar Info Display - Positioned on the gradient area */}
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col items-center text-center pointer-events-auto mb-2"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-2xl font-bold text-white tracking-wide">{config.avatarName}</h2>
                    <button 
                      onClick={() => setShowContact(true)}
                      className="p-1.5 bg-white/10 hover:bg-white/20 rounded-full text-white/40 hover:text-white transition-all backdrop-blur-sm"
                    >
                      <Info size={14} />
                    </button>
                  </div>
                  <div className="h-[1px] w-12 bg-white/20 mb-2" />
                  <p className="text-white/50 text-xs font-medium tracking-[0.4em] uppercase">{config.avatarTitle}</p>
                </motion.div>
              </div>
              
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setView('chat')}
                className="w-full max-w-[280px] py-3.5 bg-white/10 backdrop-blur-xl border border-white/20 rounded-full text-white text-lg font-medium flex items-center justify-center gap-2 shadow-xl"
              >
                <MessageSquare size={20} />
                与分身对话
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleEnterExhibition}
                className="w-full max-w-[280px] py-4 bg-[#0095FF] rounded-full text-white text-lg font-medium flex items-center justify-center gap-2 shadow-xl shadow-blue-500/40"
              >
                <span className="text-xs">▶</span> 进入展厅
              </motion.button>
            </div>
          </motion.div>
        )}

        {view === 'chat' && (
          <motion.div
            key="chat"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-0 z-30 flex flex-col pointer-events-none"
          >
            <ChatInterface 
              onBack={() => setView('home')} 
              isBackgroundMuted={isMuted}
              setIsBackgroundMuted={setIsMuted}
              onVoiceStatusChange={handleVoiceStatusChange}
              config={config}
              updateConfig={updateConfig}
            />
          </motion.div>
        )}
      </AnimatePresence>
        </>
      )}
    </div>
  );
}

function ChatInterface({ 
  onBack, 
  isBackgroundMuted, 
  setIsBackgroundMuted,
  onVoiceStatusChange,
  config,
  updateConfig
}: { 
  onBack: () => void;
  isBackgroundMuted: boolean;
  setIsBackgroundMuted: (muted: boolean) => void;
  onVoiceStatusChange: (status: string) => void;
  config: AppConfig;
  updateConfig: (c: Partial<AppConfig>) => void;
}) {
  const [mode, setMode] = useState<'text' | 'voice'>('text');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([
    { role: 'assistant', text: "您好！我是您的AI数字分身。有什么我可以帮您的吗？" }
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === 'voice') {
      setIsBackgroundMuted(true);
    }
  }, [mode, setIsBackgroundMuted]);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;
    
    const newMessages = [...messages, { role: 'user' as const, text }];
    setMessages(newMessages);
    setInput("");
    setIsTyping(true);

    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: text,
        config: {
          systemInstruction: config.knowledgeBase,
        }
      });

      const reply = response.text || "对不起，我暂时无法回答。";
      setMessages([...newMessages, { role: 'assistant' as const, text: reply }]);
      
      // Auto TTS for the reply
      speak(reply);
    } catch (error) {
      console.error("AI Error:", error);
      setMessages([...newMessages, { role: 'assistant' as const, text: "抱歉，连接服务器时出现问题。" }]);
    } finally {
      setIsTyping(false);
    }
  };

  const speak = (text: string) => {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      window.speechSynthesis.speak(utterance);
    }
  };

  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("您的浏览器不支持语音识别功能。");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      handleSendMessage(transcript);
    };
    recognition.start();
  };

  return (
    <div className="flex flex-col h-full pointer-events-auto">
      {/* Upper Area - Ghost area to show video background */}
      <div className="h-[45%] flex flex-col justify-end p-4">
        <div className="flex items-center justify-between">
           <button 
            onClick={onBack} 
            className="p-3 bg-black/40 backdrop-blur-md rounded-full text-white/70 hover:text-white border border-white/10"
          >
            <X size={24} />
          </button>
          
          <div className="flex gap-2">
            <button 
              onClick={() => setMode('text')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${mode === 'text' ? 'bg-blue-600 text-white' : 'bg-black/40 text-white/70 backdrop-blur-md border border-white/10'}`}
            >
              打字交流
            </button>
            <button 
              onClick={() => setMode('voice')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${mode === 'voice' ? 'bg-blue-600 text-white' : 'bg-black/40 text-white/70 backdrop-blur-md border border-white/10'}`}
            >
              即时语音
            </button>
          </div>
        </div>
      </div>

      {/* Content Area - Occupies bottom 55% */}
      <div className="h-[55%] bg-gray-900/90 backdrop-blur-xl border-t border-white/10 flex flex-col overflow-hidden rounded-t-[32px] shadow-2xl relative">
        <AnimatePresence mode="wait">
          {mode === 'text' ? (
            <motion.div 
              key="text-mode"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="flex flex-col h-full"
            >
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {messages.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`max-w-[85%] p-4 rounded-2xl shadow-sm ${
                      m.role === 'user' 
                        ? 'bg-blue-600 text-white rounded-tr-none' 
                        : 'bg-white/5 text-white border border-white/10 rounded-tl-none'
                    }`}>
                      <p className="text-sm leading-relaxed">{m.text}</p>
                    </div>
                  </motion.div>
                ))}
                {isTyping && (
                  <div className="flex justify-start">
                    <div className="bg-white/5 p-4 rounded-2xl animate-pulse border border-white/10">
                      <div className="flex gap-1.5">
                        <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-6 pt-2">
                <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-[28px] p-2 pr-2 shadow-inner">
                  <button
                    onClick={startListening}
                    className={`p-3.5 rounded-full transition-all ${isListening ? 'bg-red-500 text-white scale-110 shadow-lg shadow-red-500/50' : 'bg-white/10 text-white/70 hover:bg-white/20'}`}
                  >
                    <Mic size={20} />
                  </button>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage(input)}
                    placeholder="问点什么..."
                    className="flex-1 bg-transparent border-none text-white placeholder-white/30 focus:outline-none text-base px-2"
                  />
                  <button
                    onClick={() => handleSendMessage(input)}
                    disabled={!input.trim()}
                    className="p-3.5 bg-blue-600 text-white rounded-full disabled:opacity-30 transition-all hover:bg-blue-500 active:scale-95 shadow-lg shadow-blue-600/30"
                  >
                    <Send size={20} />
                  </button>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="voice-mode"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="flex-1 flex flex-col items-center justify-center p-4 text-center overflow-hidden"
            >
              <LiveVoiceCall 
                onBack={() => setMode('text')} 
                onStatusChange={onVoiceStatusChange}
                config={config}
                updateConfig={updateConfig}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function LiveVoiceCall({ 
  onBack, 
  onStatusChange,
  config,
  updateConfig
}: { 
  onBack: () => void, 
  onStatusChange: (status: string) => void,
  config: AppConfig,
  updateConfig: (c: Partial<AppConfig>) => void
}) {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'speaking' | 'error'>('idle');
  const statusRef = useRef(status);
  const [selectedVoice, setSelectedVoice] = useState('Charon');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // Admin / Secret Config States
  const [isAdminAuthOpen, setIsAdminAuthOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [isAdminMode, setIsAdminMode] = useState(false);
  
  const [errorMessage, setErrorMessage] = useState("");

  const handleSettingsClick = () => {
    setIsSettingsOpen(true);
  };

  const handleAdminAccess = () => {
    if (adminPassword === "xunmei2026") {
      setIsAdminMode(true);
      setIsAdminAuthOpen(false);
      setAdminPassword("");
      setIsSettingsOpen(true);
    } else {
      alert("密码错误");
      setAdminPassword("");
    }
  };

  const [localKnowledgeBase, setLocalKnowledgeBase] = useState(config.knowledgeBase);
  const [localInfo, setLocalInfo] = useState({
    name: config.avatarName,
    title: config.avatarTitle,
    phone: config.avatarPhone,
    email: config.avatarEmail
  });
  const [localUrls, setLocalUrls] = useState({
    welcome: config.welcomeVideo,
    talking: config.talkingVideo,
    idle: config.idleVideo
  });

  const VOICES = [
    { id: 'Charon', name: 'Charon (默认音色)', desc: '成熟稳重，适合中年/青年男性' },
    { id: 'Fenrir', name: 'Fenrir (坚定有力)', desc: '低沉且富有磁性' },
    { id: 'Puck', name: 'Puck (阳光活泼)', desc: '音调较高，充满活力' },
    { id: 'Zephyr', name: 'Zephyr (专业轻快)', desc: '标准中性专业音色' },
  ];

  useEffect(() => {
    statusRef.current = status;
    onStatusChange(status);
  }, [status, onStatusChange]);
  const [micActivity, setMicActivity] = useState(0);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  const playQueuedAudio = () => {
    const ctx = audioContextRef.current;
    if (!ctx || audioQueueRef.current.length === 0 || isPlayingRef.current) return;

    isPlayingRef.current = true;
    
    const playNext = () => {
      if (audioQueueRef.current.length === 0) {
        isPlayingRef.current = false;
        // Check if we are still in speaking status and return to listening
        if (statusRef.current === 'speaking') {
          setStatus('listening');
        }
        return;
      }

      const data = audioQueueRef.current.shift()!;
      const buffer = ctx.createBuffer(1, data.length, 24000);
      buffer.getChannelData(0).set(data);
      
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      source.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;
      
      source.onended = playNext;
    };

    playNext();
  };

  const startCall = async () => {
    setStatus('connecting');
    setErrorMessage("");
    
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      }
      
      // Ensure AudioContext is active
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            console.log("Live connection established");
            setStatus('listening');
            setupMicrophone();
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Log full message for debugging
            if (!msg.serverContent?.modelTurn) {
              console.log("Live API Misc Message:", JSON.stringify(msg));
            }
            
            if (msg.serverContent?.modelTurn) {
              setStatus('speaking');
              const parts = msg.serverContent.modelTurn.parts;
              for (const part of parts) {
                if (part.text) {
                  console.log("AI Text Part:", part.text);
                }
                if (part.inlineData?.data) {
                  const binary = atob(part.inlineData.data);
                  const bytes = new Uint8Array(binary.length);
                  for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                  }
                  const pcm16 = new Int16Array(bytes.buffer);
                  const float32 = new Float32Array(pcm16.length);
                  for (let i = 0; i < pcm16.length; i++) {
                    float32[i] = pcm16[i] / 32768.0;
                  }
                  audioQueueRef.current.push(float32);
                  playQueuedAudio();
                }
              }
            }
            if (msg.serverContent?.interrupted) {
              console.log("Interruption received");
              audioQueueRef.current = [];
              isPlayingRef.current = false;
              nextStartTimeRef.current = 0;
              setStatus('listening');
            }
            if (msg.serverContent?.turnComplete) {
              console.log("Turn complete signals AI finished turn");
              if (audioQueueRef.current.length === 0) {
                setStatus('listening');
              }
            }
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            setStatus('error');
            setErrorMessage(err.message || "连接中断");
          },
          onclose: () => {
            console.log("Live connection closed");
            setStatus('idle');
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: config.knowledgeBase,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        }
      });
      
      sessionPromiseRef.current = sessionPromise;
    } catch (error: any) {
      console.error("Failed to start call:", error);
      setStatus('error');
      setErrorMessage(error.message || "无法建立语音连接");
    }
  };

  const setupMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = audioContextRef.current!;
      console.log("AudioContext Sample Rate:", ctx.sampleRate);
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      let chunkCount = 0;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const activity = Math.sqrt(sum / inputData.length);
        setMicActivity(activity);
        if (chunkCount % 100 === 0 && activity > 0.01) {
          console.log("Mic Activity detected:", activity.toFixed(4));
        }

        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        // Faster and safer base64 encoding for PCM
        const uint8 = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < uint8.length; i += 8000) {
          binary += String.fromCharCode.apply(null, Array.from(uint8.subarray(i, i + 8000)));
        }
        const base64 = btoa(binary);
        
        if (sessionPromiseRef.current && statusRef.current === 'listening') {
          if (chunkCount % 50 === 0) console.log("Sending audio chunk...", chunkCount);
          chunkCount++;
          
          sessionPromiseRef.current.then(session => {
            session.sendRealtimeInput({
              audio: { data: base64, mimeType: `audio/pcm;rate=${ctx.sampleRate}` }
            });
          }).catch(err => {
            console.error("Send audio error:", err);
          });
        }
      };
      
      source.connect(processor);
      processor.connect(ctx.destination);
    } catch (error) {
      console.error("Mic Setup Error:", error);
      setStatus('error');
      setErrorMessage("麦克风启动失败");
    }
  };

  const stopCall = () => {
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(s => s.close()).catch(() => {});
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setMicActivity(0);
    setStatus('idle');
  };

  useEffect(() => {
    return () => stopCall();
  }, []);

  return (
    <div className="flex flex-col items-center justify-around py-2 relative w-full h-full">
      {/* Settings Icon - Hidden in plain sight */}
      {(status === 'idle' || status === 'error') && (
        <button 
          onClick={handleSettingsClick}
          className="absolute top-0 right-0 p-2 text-white/5 hover:text-white/20 transition-colors z-10"
        >
          <Settings size={16} />
        </button>
      )}

      {/* Configuration Overlay */}
      <AnimatePresence>
        {isAdminAuthOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[60] bg-black/95 backdrop-blur-md flex items-center justify-center p-4"
          >
            <div className="bg-gray-800 border border-white/10 rounded-2xl p-6 w-full max-w-[280px] space-y-4 shadow-2xl">
              <h4 className="text-white font-medium text-center">管理员身份验证</h4>
              <input 
                type="password"
                value={adminPassword || ""}
                onChange={(e) => setAdminPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdminAccess()}
                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-center text-white focus:outline-none focus:border-blue-500"
                placeholder="输入管理员密码..."
                autoFocus
              />
              <div className="flex gap-2">
                <button 
                  onClick={() => setIsAdminAuthOpen(false)}
                  className="flex-1 py-3 text-white/40 hover:text-white text-sm"
                >
                  取消
                </button>
                <button 
                  onClick={handleAdminAccess}
                  className="flex-1 py-3 bg-blue-600 text-white rounded-xl text-sm font-bold"
                >
                  进入
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {isSettingsOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-black/95 backdrop-blur-md flex items-center justify-center p-4 md:p-8"
          >
            <div className={`bg-gray-900 border border-white/10 rounded-3xl p-6 md:p-10 w-full ${isAdminMode ? 'max-w-4xl max-h-[90vh] overflow-y-auto' : 'max-w-[320px]'} transition-all shadow-2xl`}>
              <div className="flex justify-between items-center mb-6">
                <h4 className="text-white text-xl font-bold">{isAdminMode ? "系统高级功能配置" : "定制音色"}</h4>
                <div className="flex gap-4">
                  {isAdminMode && (
                    <button 
                      onClick={() => {
                        updateConfig({
                          knowledgeBase: localKnowledgeBase,
                          welcomeVideo: localUrls.welcome,
                          talkingVideo: localUrls.talking,
                          idleVideo: localUrls.idle,
                          avatarName: localInfo.name,
                          avatarTitle: localInfo.title,
                          avatarPhone: localInfo.phone,
                          avatarEmail: localInfo.email
                        });
                        setIsSettingsOpen(false);
                        setTimeout(() => setIsAdminMode(false), 300);
                      }}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-6 py-2 rounded-full transition-all"
                    >
                      保存并应用
                    </button>
                  )}
                  <button onClick={() => {
                    setIsSettingsOpen(false);
                    setTimeout(() => setIsAdminMode(false), 300);
                  }} className="text-white/40 hover:text-white p-2">
                    <X size={24} />
                  </button>
                </div>
              </div>

              {!isAdminMode ? (
                <div className="grid grid-cols-1 gap-3">
                  {VOICES.map(voice => (
                    <button
                      key={voice.id}
                      onClick={() => {
                        setSelectedVoice(voice.id);
                        setIsSettingsOpen(false);
                      }}
                      className={`flex flex-col items-start px-5 py-4 rounded-2xl transition-all border ${
                        selectedVoice === voice.id 
                          ? 'bg-blue-600 border-blue-500 text-white' 
                          : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      <div className="font-semibold text-sm">{voice.name}</div>
                      <div className="text-[11px] opacity-60 mt-1">{voice.desc}</div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 text-left">
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-blue-400 uppercase tracking-widest">角色身份信息</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">展示姓名</span>
                          <input 
                            value={localInfo.name || ""}
                            onChange={(e) => setLocalInfo({...localInfo, name: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white"
                            placeholder="如：刘先生"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">展示职衔</span>
                          <input 
                            value={localInfo.title || ""}
                            onChange={(e) => setLocalInfo({...localInfo, title: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white"
                            placeholder="如：总监"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">联系电话</span>
                          <input 
                            value={localInfo.phone || ""}
                            onChange={(e) => setLocalInfo({...localInfo, phone: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">联系邮箱</span>
                          <input 
                            value={localInfo.email || ""}
                            onChange={(e) => setLocalInfo({...localInfo, email: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-blue-400 uppercase tracking-widest">知识库 & 人设指令 (Prompt)</label>
                      <textarea 
                        value={localKnowledgeBase || ""}
                        onChange={(e) => setLocalKnowledgeBase(e.target.value)}
                        className="w-full h-48 bg-white/5 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                        placeholder="定义回答风格、业务知识、禁忌语等..."
                      />
                    </div>
                  </div>

                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-blue-400 uppercase tracking-widest">视频流资源配置 (MP4 URL)</label>
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">Welcome - 出场动画</span>
                          <input 
                            value={localUrls.welcome || ""}
                            onChange={(e) => setLocalUrls({...localUrls, welcome: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-[11px] text-white"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">Idle - 等待/循环</span>
                          <input 
                            value={localUrls.idle || ""}
                            onChange={(e) => setLocalUrls({...localUrls, idle: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-[11px] text-white"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] text-white/40">Talking - 说话中</span>
                          <input 
                            value={localUrls.talking || ""}
                            onChange={(e) => setLocalUrls({...localUrls, talking: e.target.value})}
                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-[11px] text-white"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="p-6 bg-blue-500/5 border border-blue-500/10 rounded-2xl">
                      <p className="text-xs text-white/60 leading-relaxed italic">
                        提示：配置将在本地持久化保存。更改视频资源后，系统将重新加载对应的播放流。
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative mt-2">
        <AnimatePresence>
          {status === 'speaking' && (
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1.6, opacity: 0.2 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }}
              className="absolute inset-0 bg-green-500 rounded-full"
            />
          )}
          {status === 'listening' && micActivity > 0.05 && (
            <motion.div 
              style={{ scale: 1 + micActivity * 2 }}
              className="absolute inset-0 bg-blue-500/20 rounded-full"
            />
          )}
        </AnimatePresence>
        
        <div className={`w-28 h-28 md:w-32 md:h-32 rounded-full flex items-center justify-center z-10 relative border-4 transition-all duration-300 ${
          status === 'listening' ? 'border-blue-500 bg-blue-500/20' : 
          status === 'speaking' ? 'border-green-500 bg-green-500/20' : 
          status === 'error' ? 'border-red-500 bg-red-500/20' :
          'border-white/10 bg-white/5'
        }`}>
          {status === 'idle' ? <Mic size={36} className="text-white/40" /> : 
           status === 'connecting' ? <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /> :
           status === 'error' ? <X size={36} className="text-red-500" /> :
           <Volume2 size={36} className={status === 'speaking' ? 'text-green-500' : 'text-blue-500'} />}
        </div>
      </div>

      <div className="space-y-1">
        <h3 className="text-xl font-semibold text-white">
          {status === 'idle' ? "准备通话" : 
           status === 'connecting' ? "正在呼叫..." :
           status === 'listening' ? "正在倾听..." :
           status === 'speaking' ? "正在回答..." : "出现错误"}
        </h3>
        <p className="text-white/40 text-xs px-4 h-5">
          {status === 'idle' ? "点击下方按钮开始即时语音交流" : 
           status === 'listening' ? (micActivity > 0.01 ? "正在接收声音..." : "等待您开口说话") : 
           status === 'error' ? errorMessage : ""}
        </p>
      </div>

      <div className="flex flex-col items-center gap-3 mt-4 w-full px-8">
        {status === 'idle' || status === 'error' ? (
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={startCall}
            className="w-full py-3.5 bg-blue-600 hover:bg-blue-500 text-white rounded-full font-bold transition-all shadow-xl shadow-blue-600/40 text-lg"
          >
            开始语音通话
          </motion.button>
        ) : (
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={stopCall}
            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-full font-medium transition-all shadow-lg shadow-red-600/30 text-base"
          >
            结束通话
          </motion.button>
        )}
      </div>

      <button onClick={onBack} className="text-white/20 text-[10px] opacity-50 hover:text-white/50 underline underline-offset-4">
         切换回文字模式
      </button>

      {/* Secret Admin Entrance - Almost invisible */}
      {(status === 'idle' || status === 'error') && !isSettingsOpen && !isAdminAuthOpen && (
        <button 
          onClick={() => setIsAdminAuthOpen(true)}
          className="absolute bottom-0 right-0 w-8 h-8 opacity-0 hover:opacity-5 cursor-default z-10"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

