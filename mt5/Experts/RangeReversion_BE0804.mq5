//+------------------------------------------------------------------+
//|                                      RangeReversion_BE0804.mq5 |
//|  北京时间 00:00-04:00 Donchian+ATR 区间高抛低吸 (M1)              |
//+------------------------------------------------------------------+
#property copyright "re-test"
#property version   "1.20"

#include <Trade/Trade.mqh>

input group "=== 时段 ==="
input int      InpServerUtcOffsetHours = -1;   // 服务器相对UTC；-1=自动检测
input int      InpBeijingUtcOffset     = 8;
input int      InpSessionStartHour     = 0;
input int      InpSessionEndHour       = 4;
input bool     InpCloseAtSessionEnd    = true;

input group "=== 指标（分钟 → K 线根数）==="
input int      InpLookbackMinutes      = 240;
input int      InpDonchianMinutes      = 180;
input int      InpAtrMinutes           = 70;
input int      InpAdxMinutes           = 70;

input group "=== 区间过滤（M1 默认已放宽）==="
input double   InpMinRangeUsd          = 5.0;
input double   InpMaxRangeUsd          = 40.0;
input double   InpMinRangeAtr          = 2.0;
input double   InpMaxRangeAtr          = 15.0;
input double   InpMaxAdx               = 45.0;
input double   InpMaxEfficiencyRatio   = 0.55;

input group "=== 入场 / 出场 ==="
input double   InpEntryBufferUsd       = 0.5;
input double   InpSlAtrMult            = 0.35;
input double   InpSlMinUsd             = 3.0;
input bool     InpTpAtMid              = true;
input double   InpTpEdgeRatio          = 0.55;
input double   InpBreakoutAtrMult      = 0.25;
input bool     InpBreakoutDisablesSession = true;

input group "=== 交易 ==="
input double   InpLots                 = 0.01;
input ulong    InpMagic                = 20260605;
input int      InpMaxSpreadPoints      = 0;
input int      InpSlippagePoints       = 30;
input string   InpTradeComment         = "RR_BE0804";
input bool     InpDebugLog             = true;

CTrade         g_trade;
datetime       g_lastBarTime           = 0;
int            g_sessionDayKey         = 0;
bool           g_sessionDisabled       = false;
int            g_serverUtcOffsetHours  = 3;

int            g_atrHandle             = INVALID_HANDLE;
int            g_adxHandle             = INVALID_HANDLE;
int            g_atrPeriod             = 0;
int            g_adxPeriod             = 0;

int            g_statBars              = 0;
int            g_statInSession         = 0;
int            g_statNotEnoughBars     = 0;
int            g_statIndCopyFail       = 0;
int            g_statRangeOk           = 0;
int            g_statRangeValid        = 0;
int            g_statSpreadBlock       = 0;
int            g_statBreakout          = 0;
int            g_statDisabled          = 0;
int            g_statBuyTouch          = 0;
int            g_statSellTouch         = 0;
int            g_statOpenFail          = 0;
int            g_statOpenOk            = 0;
int            g_statFailWidth         = 0;
int            g_statFailAtr         = 0;
int            g_statFailRegime        = 0;

struct RangeState
{
   double top;
   double bottom;
   double mid;
   double width;
   double atr;
   double adx;
   double er;
   bool   valid;
   bool   widthOk;
   bool   atrOk;
   bool   regimeOk;
};

//+------------------------------------------------------------------+
int ResolveServerUtcOffset()
{
   if(InpServerUtcOffsetHours >= -12 && InpServerUtcOffsetHours <= 14 &&
      InpServerUtcOffsetHours != -1)
      return InpServerUtcOffsetHours;

   const int autoOff = (int)MathRound((TimeCurrent() - TimeGMT()) / 3600.0);
   PrintFormat("自动检测服务器UTC偏移: %+d (TimeCurrent - TimeGMT)", autoOff);
   return autoOff;
}

//+------------------------------------------------------------------+
int OnInit()
{
   if(InpSessionStartHour >= InpSessionEndHour)
   {
      Print("无效时段");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_serverUtcOffsetHours = ResolveServerUtcOffset();

   g_atrPeriod = BarsForMinutes(InpAtrMinutes);
   g_adxPeriod = BarsForMinutes(InpAdxMinutes);

   g_atrHandle = iATR(_Symbol, _Period, g_atrPeriod);
   g_adxHandle = iADX(_Symbol, _Period, g_adxPeriod);
   if(g_atrHandle == INVALID_HANDLE || g_adxHandle == INVALID_HANDLE)
   {
      Print("指标创建失败");
      return INIT_FAILED;
   }

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   if(!g_trade.SetTypeFillingBySymbol(_Symbol))
      g_trade.SetTypeFilling(ORDER_FILLING_RETURN);

   const int need = MinBarsRequired();
   PrintFormat("RangeReversion v1.20 | %s %s | 最少K线=%d | Donchian=%d ATR=%d ADX=%d",
               _Symbol, EnumToString(_Period), need,
               BarsForMinutes(InpDonchianMinutes), g_atrPeriod, g_adxPeriod);
   PrintFormat("北京 %02d:00-%02d:00 | 服务器UTC%+d → 北京 %+d 小时",
               InpSessionStartHour, InpSessionEndHour,
               g_serverUtcOffsetHours,
               InpBeijingUtcOffset - g_serverUtcOffsetHours);
   PrintFormat("区间宽度 $%.0f-%.0f | 宽度/ATR %.1f-%.1f | ADX≤%.0f ER≤%.2f",
               InpMinRangeUsd, InpMaxRangeUsd,
               InpMinRangeAtr, InpMaxRangeAtr,
               InpMaxAdx, InpMaxEfficiencyRatio);

   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(g_atrHandle != INVALID_HANDLE) IndicatorRelease(g_atrHandle);
   if(g_adxHandle != INVALID_HANDLE) IndicatorRelease(g_adxHandle);
}

//+------------------------------------------------------------------+
void OnTesterInit()
{
   int sess = 0;
   const int total = Bars(_Symbol, _Period);
   const int scan = MathMin(total - 1, 50000);
   for(int sh = 1; sh < scan; sh++)
   {
      MqlDateTime dt;
      if(!BeijingFromBar(sh, dt))
         continue;
      if(IsInSession(dt.hour))
         sess++;
   }
   PrintFormat("[TesterInit] 扫描最近 %d 根K线: 北京时段内 %d 根 (%.1f%%)",
               scan, sess, 100.0 * sess / MathMax(1, scan));
   if(sess == 0)
      Print(">>> 时段内K线为0: 请改 InpServerUtcOffsetHours 或对照 PrintFirstLastBarBeijing");
   else
      PrintFirstLastBarBeijing();
}

//+------------------------------------------------------------------+
void OnTesterDeinit()
{
}

//+------------------------------------------------------------------+
double OnTester()
{
   if(InpDebugLog)
      PrintDiagnostics();
   return 0.0;
}

//+------------------------------------------------------------------+
void OnTick()
{
   if(!IsNewBar())
      return;

   g_statBars++;

   MqlDateTime beijing;
   if(!BeijingFromBar(1, beijing))
      return;

   const int dayKey = beijing.year * 10000 + beijing.mon * 100 + beijing.day;
   if(dayKey != g_sessionDayKey)
   {
      g_sessionDayKey = dayKey;
      g_sessionDisabled = false;
   }

   if(!IsInSession(beijing.hour))
   {
      if(InpCloseAtSessionEnd && beijing.hour >= InpSessionEndHour)
         CloseAllPositions("session_end");
      return;
   }

   g_statInSession++;

   if(InpMaxSpreadPoints > 0)
   {
      const int spread = (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
      if(spread > InpMaxSpreadPoints)
      {
         g_statSpreadBlock++;
         return;
      }
   }

   RangeState rng;
   if(!DetectRange(rng))
      return;

   g_statRangeOk++;

   if(!rng.valid)
   {
      if(!rng.widthOk)  g_statFailWidth++;
      else if(!rng.atrOk) g_statFailAtr++;
      else if(!rng.regimeOk) g_statFailRegime++;
      return;
   }

   g_statRangeValid++;

   const double bar1Close = iClose(_Symbol, _Period, 1);
   const double bar1High  = iHigh(_Symbol, _Period, 1);
   const double bar1Low   = iLow(_Symbol, _Period, 1);

   const double breakoutBuf = InpBreakoutAtrMult * rng.atr;
   const bool breakout = (bar1Close > rng.top + breakoutBuf) ||
                         (bar1Close < rng.bottom - breakoutBuf);

   if(breakout)
   {
      g_statBreakout++;
      if(HasOpenPosition())
         CloseAllPositions("breakout");
      if(InpBreakoutDisablesSession)
         g_sessionDisabled = true;
      return;
   }

   if(g_sessionDisabled)
   {
      g_statDisabled++;
      return;
   }

   if(HasOpenPosition())
      return;

   const bool buyTouch  = (bar1Low <= rng.bottom + InpEntryBufferUsd);
   const bool sellTouch = (bar1High >= rng.top - InpEntryBufferUsd);

   if(buyTouch && sellTouch)
      return;

   if(buyTouch)
   {
      g_statBuyTouch++;
      OpenRangeTrade(true, rng);
   }
   else if(sellTouch)
   {
      g_statSellTouch++;
      OpenRangeTrade(false, rng);
   }
}

//+------------------------------------------------------------------+
int BarMinutes()
{
   return (int)MathMax(1, PeriodSeconds(_Period) / 60);
}

//+------------------------------------------------------------------+
int BarsForMinutes(const int minutes)
{
   return (int)MathMax(1, (int)MathRound((double)minutes / BarMinutes()));
}

//+------------------------------------------------------------------+
int MinBarsRequired()
{
   const int lookback  = BarsForMinutes(InpLookbackMinutes);
   const int donchian  = BarsForMinutes(InpDonchianMinutes);
   const int adxPeriod = BarsForMinutes(InpAdxMinutes);
   return MathMax(lookback, donchian) + adxPeriod * 2 + 10;
}

//+------------------------------------------------------------------+
datetime ServerToBeijing(const datetime serverTime)
{
   const int deltaHours = InpBeijingUtcOffset - g_serverUtcOffsetHours;
   return serverTime + deltaHours * 3600;
}

//+------------------------------------------------------------------+
bool BeijingFromBar(const int shift, MqlDateTime &dt)
{
   const datetime barTime = iTime(_Symbol, _Period, shift);
   if(barTime == 0)
      return false;
   TimeToStruct(ServerToBeijing(barTime), dt);
   return true;
}

//+------------------------------------------------------------------+
bool IsInSession(const int hour)
{
   return (hour >= InpSessionStartHour && hour < InpSessionEndHour);
}

//+------------------------------------------------------------------+
bool IsNewBar()
{
   const datetime t = iTime(_Symbol, _Period, 0);
   if(t == 0 || t == g_lastBarTime)
      return false;
   g_lastBarTime = t;
   return true;
}

//+------------------------------------------------------------------+
double NormalizePx(const double price)
{
   const double tick = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   const int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   if(tick <= 0.0)
      return NormalizeDouble(price, digits);
   return NormalizeDouble(MathRound(price / tick) * tick, digits);
}

//+------------------------------------------------------------------+
double SlBuffer(const double atr)
{
   return MathMax(InpSlMinUsd, InpSlAtrMult * atr);
}

//+------------------------------------------------------------------+
double CalcTp(const bool isBuy, const double entry, const RangeState &rng)
{
   if(InpTpAtMid)
      return rng.mid;
   const double span = rng.top - rng.bottom;
   if(isBuy)
      return entry + span * InpTpEdgeRatio;
   return entry - span * InpTpEdgeRatio;
}

//+------------------------------------------------------------------+
double EfficiencyRatio(const int period, const int shiftStart)
{
   if(period < 1)
      return 1.0;

   const double cLast  = iClose(_Symbol, _Period, shiftStart);
   const double cFirst = iClose(_Symbol, _Period, shiftStart + period);
   double path = 0.0;

   for(int i = 0; i < period; i++)
   {
      const double c0 = iClose(_Symbol, _Period, shiftStart + i);
      const double c1 = iClose(_Symbol, _Period, shiftStart + i + 1);
      path += MathAbs(c0 - c1);
   }

   if(path <= 0.0)
      return 1.0;
   return MathAbs(cLast - cFirst) / path;
}

//+------------------------------------------------------------------+
bool DetectRange(RangeState &rng)
{
   const int donchian  = BarsForMinutes(InpDonchianMinutes);
   const int need      = MinBarsRequired();

   if(Bars(_Symbol, _Period) < need)
   {
      g_statNotEnoughBars++;
      return false;
   }

   const int startShift = 2;
   const int hiShift = iHighest(_Symbol, _Period, MODE_HIGH, donchian, startShift);
   const int loShift = iLowest(_Symbol, _Period, MODE_LOW, donchian, startShift);
   if(hiShift < 0 || loShift < 0)
      return false;

   rng.top    = iHigh(_Symbol, _Period, hiShift);
   rng.bottom = iLow(_Symbol, _Period, loShift);
   rng.width  = rng.top - rng.bottom;
   rng.mid    = (rng.top + rng.bottom) * 0.5;

   double atrBuf[], adxBuf[];
   ArraySetAsSeries(atrBuf, true);
   ArraySetAsSeries(adxBuf, true);

   if(CopyBuffer(g_atrHandle, 0, startShift, 1, atrBuf) != 1 ||
      CopyBuffer(g_adxHandle, 0, startShift, 1, adxBuf) != 1)
   {
      g_statIndCopyFail++;
      return false;
   }

   rng.atr = atrBuf[0];
   rng.adx = adxBuf[0];
   rng.er  = EfficiencyRatio(donchian, startShift);

   if(rng.atr <= 0.0 || rng.width <= 0.0)
      return false;

   rng.widthOk  = (rng.width >= InpMinRangeUsd && rng.width <= InpMaxRangeUsd);
   const double atrRatio = rng.width / rng.atr;
   rng.atrOk    = (atrRatio >= InpMinRangeAtr && atrRatio <= InpMaxRangeAtr);
   rng.regimeOk = (rng.adx <= InpMaxAdx && rng.er <= InpMaxEfficiencyRatio);
   rng.valid    = rng.widthOk && rng.atrOk && rng.regimeOk;
   return true;
}

//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      const ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
void CloseAllPositions(const string reason)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      const ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      g_trade.PositionClose(ticket);
   }
}

//+------------------------------------------------------------------+
bool StopsValid(const bool isBuy, const double price, const double sl, const double tp)
{
   const int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   const double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   const double minDist = stopsLevel * point;

   if(isBuy)
   {
      if(sl > 0 && price - sl < minDist) return false;
      if(tp > 0 && tp - price < minDist) return false;
   }
   else
   {
      if(sl > 0 && sl - price < minDist) return false;
      if(tp > 0 && price - tp < minDist) return false;
   }
   return true;
}

//+------------------------------------------------------------------+
void OpenRangeTrade(const bool isBuy, const RangeState &rng)
{
   const double buf = SlBuffer(rng.atr);
   double sl, tp, price;

   if(isBuy)
   {
      price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      sl = rng.bottom - buf;
      tp = CalcTp(true, price, rng);
   }
   else
   {
      price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      sl = rng.top + buf;
      tp = CalcTp(false, price, rng);
   }

   sl = NormalizePx(sl);
   tp = NormalizePx(tp);

   if(isBuy && (tp <= price || sl >= price))
   {
      g_statOpenFail++;
      return;
   }
   if(!isBuy && (tp >= price || sl <= price))
   {
      g_statOpenFail++;
      return;
   }

   if(!StopsValid(isBuy, price, sl, tp))
   {
      g_statOpenFail++;
      return;
   }

   const bool ok = isBuy
      ? g_trade.Buy(InpLots, _Symbol, 0, sl, tp, InpTradeComment)
      : g_trade.Sell(InpLots, _Symbol, 0, sl, tp, InpTradeComment);

   if(ok)
      g_statOpenOk++;
   else
   {
      g_statOpenFail++;
      PrintFormat("开仓失败 %s ret=%d desc=%s",
                  isBuy ? "BUY" : "SELL",
                  g_trade.ResultRetcode(),
                  g_trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
void PrintDiagnostics()
{
   Print("========== RangeReversion 回测诊断 v1.20 ==========");
   PrintFormat("总新K线: %d", g_statBars);
   PrintFormat("北京 %02d-%02d 时段K线: %d",
               InpSessionStartHour, InpSessionEndHour, g_statInSession);
   PrintFormat("K线不足(需%d): %d", MinBarsRequired(), g_statNotEnoughBars);
   PrintFormat("指标CopyBuffer失败: %d", g_statIndCopyFail);
   PrintFormat("区间计算成功: %d", g_statRangeOk);
   PrintFormat("区间有效: %d", g_statRangeValid);
   PrintFormat("过滤失败 width/atr/regime: %d / %d / %d",
               g_statFailWidth, g_statFailAtr, g_statFailRegime);
   PrintFormat("点差拦截: %d", g_statSpreadBlock);
   PrintFormat("破位: %d | 时段停用跳过: %d", g_statBreakout, g_statDisabled);
   PrintFormat("触下沿/触上沿: %d / %d", g_statBuyTouch, g_statSellTouch);
   PrintFormat("开仓成功/失败: %d / %d", g_statOpenOk, g_statOpenFail);

   if(g_statInSession == 0)
   {
      Print(">>> 全年无北京时段K线 → 时区偏移错误");
      PrintFirstLastBarBeijing();
   }
   else if(g_statRangeValid == 0)
      Print(">>> 有时段但区间从未有效 → 放宽 InpMaxRangeAtr / InpMaxRangeUsd");
   else if(g_statOpenOk == 0 && g_statBuyTouch + g_statSellTouch > 0)
      Print(">>> 有触边但开不了仓 → 看 StopsLevel / 手数 / 日志 retcode");
   else if(g_statOpenOk == 0)
      Print(">>> 区间有效但很少触边 → 正常或减小 InpEntryBufferUsd");

   Print("===================================================");
}

//+------------------------------------------------------------------+
void PrintFirstLastBarBeijing()
{
   const int last = Bars(_Symbol, _Period) - 1;
   if(last < 1)
      return;
   MqlDateTime bNew, bOld;
   BeijingFromBar(0, bNew);
   BeijingFromBar(last, bOld);
   PrintFormat("K线北京时刻  最新=%04d-%02d-%02d %02d:%02d  最早=%04d-%02d-%02d %02d:%02d",
               bNew.year, bNew.mon, bNew.day, bNew.hour, bNew.min,
               bOld.year, bOld.mon, bOld.day, bOld.hour, bOld.min);
}

//+------------------------------------------------------------------+
