//+------------------------------------------------------------------+
//|                                                  NervaFX_EA.mq5  |
//|                        Copyright 2026, NervaFX                    |
//|                        https://nervafx.vercel.app                 |
//+------------------------------------------------------------------+
#property copyright "NervaFX"
#property link      "https://nervafx.vercel.app"
#property version   "1.00"
#property strict

//--- Input parameters
input string InpApiKey         = "";                              // EA API Key (from AutoTrader dashboard)
input string InpServerUrl      = "https://nervafx.vercel.app";    // Server URL
input int    InpHeartbeatSec   = 15;                              // Heartbeat interval (seconds)
input int    InpPollSec        = 5;                               // Command poll interval (seconds)
input int    InpRequestTimeout = 5000;                            // HTTP timeout (ms)
input int    InpSlippage       = 10;                              // Max slippage (points)

//--- Global state
datetime g_lastHeartbeat = 0;
datetime g_lastPoll      = 0;
int      g_pendingCount  = 0;
int      g_heartbeatOk   = 0;
int      g_heartbeatFail = 0;

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   if(StringLen(InpApiKey) < 10)
   {
      Alert("NervaFX EA: Please enter your API key from the AutoTrader dashboard.");
      return INIT_PARAMETERS_INCORRECT;
   }

   EventSetMillisecondTimer(1000);
   Print("NervaFX EA initialized. Server: ", InpServerUrl);
   Print("Heartbeat every ", InpHeartbeatSec, "s, Poll every ", InpPollSec, "s");
   UpdateChart("Initializing...");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
   Print("NervaFX EA stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| Timer event — runs every 1 second                                 |
//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();

   if(now - g_lastHeartbeat >= InpHeartbeatSec)
   {
      SendHeartbeat();
      g_lastHeartbeat = now;
   }

   if(now - g_lastPoll >= InpPollSec)
   {
      PollCommands();
      g_lastPoll = now;
   }

   UpdateChart("");
}

//+------------------------------------------------------------------+
//| Display status on chart                                           |
//+------------------------------------------------------------------+
void UpdateChart(string extra)
{
   string status = "● NervaFX AutoTrader\n";
   status += "─────────────────────\n";
   status += "API Key: " + StringSubstr(InpApiKey, 0, 8) + "...\n";
   status += "Server: " + InpServerUrl + "\n";
   status += "Heartbeats: " + IntegerToString(g_heartbeatOk) + " OK / " + IntegerToString(g_heartbeatFail) + " fail\n";
   status += "Pending commands: " + IntegerToString(g_pendingCount) + "\n";
   status += "Last heartbeat: " + TimeToString(g_lastHeartbeat, TIME_DATE | TIME_SECONDS) + "\n";
   status += "Last poll: " + TimeToString(g_lastPoll, TIME_DATE | TIME_SECONDS) + "\n";
   if(StringLen(extra) > 0)
      status += "\n" + extra;
   Comment(status);
}

//+------------------------------------------------------------------+
//| Build JSON string for open positions                              |
//+------------------------------------------------------------------+
string BuildPositionsJson()
{
   string json = "[";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      string symbol   = PositionGetString(POSITION_SYMBOL);
      double lots     = PositionGetDouble(POSITION_VOLUME);
      double price    = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl       = PositionGetDouble(POSITION_SL);
      double tp       = PositionGetDouble(POSITION_TP);
      double profit   = PositionGetDouble(POSITION_PROFIT);
      long   posType  = PositionGetInteger(POSITION_TYPE);
      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
      string dir      = posType == POSITION_TYPE_BUY ? "BUY" : "SELL";

      if(i > 0) json += ",";
      json += "{";
      json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
      json += "\"instrument\":\"" + symbol + "\",";
      json += "\"dir\":\"" + dir + "\",";
      json += "\"lots\":" + DoubleToString(lots, 2) + ",";
      json += "\"open_price\":" + DoubleToString(price, 5) + ",";
      json += "\"sl\":" + DoubleToString(sl, 5) + ",";
      json += "\"tp\":" + DoubleToString(tp, 5) + ",";
      json += "\"profit\":" + DoubleToString(profit, 2) + ",";
      json += "\"open_time\":\"" + TimeToString(openTime, TIME_DATE | TIME_SECONDS) + "\"";
      json += "}";
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Build JSON for today's trade history                              |
//+------------------------------------------------------------------+
string BuildHistoryJson()
{
   string json = "[";
   MqlDateTime dtNow;
   TimeCurrent(dtNow);
   datetime dayStart = StringToTime(IntegerToString(dtNow.year) + "." +
                                     IntegerToString(dtNow.mon) + "." +
                                     IntegerToString(dtNow.day));

   if(!HistorySelect(dayStart, TimeCurrent()))
      return "[]";

   int total = HistoryDealsTotal();
   int count = 0;
   for(int i = total - 1; i >= 0 && count < 20; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;

      long dealType = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(dealType != DEAL_TYPE_BUY && dealType != DEAL_TYPE_SELL) continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_INOUT) continue;

      string symbol  = HistoryDealGetString(ticket, DEAL_SYMBOL);
      double lots    = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      double profit  = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      datetime cTime = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      string dir     = dealType == DEAL_TYPE_BUY ? "BUY" : "SELL";

      if(count > 0) json += ",";
      json += "{";
      json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
      json += "\"instrument\":\"" + symbol + "\",";
      json += "\"dir\":\"" + dir + "\",";
      json += "\"lots\":" + DoubleToString(lots, 2) + ",";
      json += "\"profit\":" + DoubleToString(profit, 2) + ",";
      json += "\"close_time\":\"" + TimeToString(cTime, TIME_DATE | TIME_SECONDS) + "\"";
      json += "}";
      count++;
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Send heartbeat to server                                          |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   string url = InpServerUrl + "/api/ea-heartbeat";
   string headers = "Content-Type: application/json\r\nX-EA-Key: " + InpApiKey + "\r\n";

   string body = "{";
   body += "\"account_number\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   body += "\"broker_name\":\"" + AccountInfoString(ACCOUNT_COMPANY) + "\",";
   body += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   body += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   body += "\"floating_pl\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",";
   body += "\"margin_used\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   body += "\"margin_free\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   body += "\"open_positions\":" + BuildPositionsJson() + ",";
   body += "\"trade_history\":" + BuildHistoryJson();
   body += "}";

   char postData[];
   char result[];
   string resultHeaders;

   StringToCharArray(body, postData, 0, StringLen(body), CP_UTF8);

   int res = WebRequest("POST", url, headers, InpRequestTimeout, postData, result, resultHeaders);

   if(res == 200)
      g_heartbeatOk++;
   else
   {
      g_heartbeatFail++;
      if(res == -1)
         Print("NervaFX: Heartbeat failed — check URL is whitelisted in MT5 Options > Expert Advisors");
      else
         Print("NervaFX: Heartbeat HTTP ", res);
   }
}

//+------------------------------------------------------------------+
//| Poll and execute commands from server                             |
//+------------------------------------------------------------------+
void PollCommands()
{
   string url = InpServerUrl + "/api/ea-commands";
   string headers = "X-EA-Key: " + InpApiKey + "\r\n";

   char postData[];
   char result[];
   string resultHeaders;

   int res = WebRequest("GET", url, headers, InpRequestTimeout, postData, result, resultHeaders);

   if(res != 200)
   {
      if(res == -1)
         Print("NervaFX: Poll failed — check URL whitelist");
      return;
   }

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   // Parse commands array from {"commands":[...]}
   int cmdStart = StringFind(response, "\"commands\":[");
   if(cmdStart < 0) { g_pendingCount = 0; return; }

   // Count and process each command object
   int arrStart = StringFind(response, "[", cmdStart);
   int arrEnd   = StringFind(response, "]", arrStart);
   if(arrStart < 0 || arrEnd < 0 || arrEnd <= arrStart + 1) { g_pendingCount = 0; return; }

   string arrContent = StringSubstr(response, arrStart + 1, arrEnd - arrStart - 1);
   if(StringLen(StringTrimRight(StringTrimLeft(arrContent))) == 0) { g_pendingCount = 0; return; }

   // Process each command object
   int pos = 0;
   int cmdCount = 0;
   while(pos < StringLen(arrContent))
   {
      int objStart = StringFind(arrContent, "{", pos);
      if(objStart < 0) break;
      int objEnd = StringFind(arrContent, "}", objStart);
      if(objEnd < 0) break;

      string obj = StringSubstr(arrContent, objStart, objEnd - objStart + 1);
      ProcessCommand(obj);
      cmdCount++;
      pos = objEnd + 1;
   }
   g_pendingCount = cmdCount;
}

//+------------------------------------------------------------------+
//| Extract a string value from JSON object                           |
//+------------------------------------------------------------------+
string JsonGetString(const string &json, const string key)
{
   string search = "\"" + key + "\":\"";
   int start = StringFind(json, search);
   if(start < 0) return "";
   start += StringLen(search);
   int end = StringFind(json, "\"", start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
}

//+------------------------------------------------------------------+
//| Extract a double value from JSON object                           |
//+------------------------------------------------------------------+
double JsonGetDouble(const string &json, const string key)
{
   string search = "\"" + key + "\":";
   int start = StringFind(json, search);
   if(start < 0) return 0;
   start += StringLen(search);
   // Find end of number (next comma, } or end)
   string rest = StringSubstr(json, start, 20);
   int len = 0;
   for(int i = 0; i < StringLen(rest); i++)
   {
      ushort ch = StringGetCharacter(rest, i);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-')
         len++;
      else
         break;
   }
   if(len == 0) return 0;
   return StringToDouble(StringSubstr(json, start, len));
}

//+------------------------------------------------------------------+
//| Process a single command and acknowledge                          |
//+------------------------------------------------------------------+
void ProcessCommand(const string &cmdJson)
{
   string id         = JsonGetString(cmdJson, "id");
   string instrument = JsonGetString(cmdJson, "instrument");
   string action     = JsonGetString(cmdJson, "action");

   // Extract params sub-object
   int paramsStart = StringFind(cmdJson, "\"params\":{");
   string paramsJson = "";
   if(paramsStart >= 0)
   {
      int pEnd = StringFind(cmdJson, "}", paramsStart + 10);
      if(pEnd >= 0)
         paramsJson = StringSubstr(cmdJson, paramsStart, pEnd - paramsStart + 1);
   }

   double lots    = JsonGetDouble(paramsJson, "lots");
   double slPips  = JsonGetDouble(paramsJson, "sl_pips");
   double tpPips  = JsonGetDouble(paramsJson, "tp_pips");
   long   ticket  = (long)JsonGetDouble(paramsJson, "ticket");
   double closePct = JsonGetDouble(paramsJson, "close_pct");

   Print("NervaFX: Executing ", action, " on ", instrument, " lots=", lots);

   string resultTicket = "";
   string errorMsg     = "";
   bool   success      = false;

   if(action == "OPEN_BUY")
      success = OpenTrade(instrument, ORDER_TYPE_BUY, lots, slPips, tpPips, resultTicket, errorMsg);
   else if(action == "OPEN_SELL")
      success = OpenTrade(instrument, ORDER_TYPE_SELL, lots, slPips, tpPips, resultTicket, errorMsg);
   else if(action == "CLOSE")
      success = CloseTrade(ticket, errorMsg);
   else if(action == "MODIFY_SL")
      success = ModifySL(ticket, slPips, errorMsg);
   else if(action == "PARTIAL_CLOSE")
      success = PartialClose(ticket, closePct, errorMsg);
   else
      errorMsg = "Unknown action: " + action;

   // Acknowledge
   AckCommand(id, success ? "acked" : "failed", resultTicket, errorMsg);
}

//+------------------------------------------------------------------+
//| Open a market order                                               |
//+------------------------------------------------------------------+
bool OpenTrade(const string symbol, ENUM_ORDER_TYPE type, double lots,
               double slPips, double tpPips, string &outTicket, string &outError)
{
   if(!SymbolSelect(symbol, true))
   {
      outError = "Symbol not found: " + symbol;
      return false;
   }

   double price = (type == ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                                            : SymbolInfoDouble(symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   double sl = 0, tp = 0;
   if(slPips > 0)
   {
      if(type == ORDER_TYPE_BUY)
      {
         sl = NormalizeDouble(price - slPips * 10 * point, digits);
         if(tpPips > 0) tp = NormalizeDouble(price + tpPips * 10 * point, digits);
      }
      else
      {
         sl = NormalizeDouble(price + slPips * 10 * point, digits);
         if(tpPips > 0) tp = NormalizeDouble(price - tpPips * 10 * point, digits);
      }
   }

   MqlTradeRequest request = {};
   MqlTradeResult  result  = {};

   request.action    = TRADE_ACTION_DEAL;
   request.symbol    = symbol;
   request.volume    = lots;
   request.type      = type;
   request.price     = price;
   request.sl        = sl;
   request.tp        = tp;
   request.deviation = InpSlippage;
   request.magic     = 202600;
   request.comment   = "NervaFX";
   request.type_filling = ORDER_FILLING_FOK;

   if(!OrderSend(request, result))
   {
      outError = "OrderSend failed: " + IntegerToString(result.retcode) + " " + result.comment;
      Print("NervaFX: ", outError);
      return false;
   }

   if(result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_PLACED)
   {
      outError = "Order rejected: " + IntegerToString(result.retcode) + " " + result.comment;
      Print("NervaFX: ", outError);
      return false;
   }

   outTicket = IntegerToString((long)result.order);
   Print("NervaFX: Order filled — ticket ", outTicket, " ", symbol, " ", lots, " lots");
   return true;
}

//+------------------------------------------------------------------+
//| Close a position by ticket                                        |
//+------------------------------------------------------------------+
bool CloseTrade(long ticket, string &outError)
{
   if(!PositionSelectByTicket(ticket))
   {
      outError = "Position not found: " + IntegerToString(ticket);
      return false;
   }

   string symbol  = PositionGetString(POSITION_SYMBOL);
   double volume  = PositionGetDouble(POSITION_VOLUME);
   long   posType = PositionGetInteger(POSITION_TYPE);
   ENUM_ORDER_TYPE closeType = (posType == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (closeType == ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                                                 : SymbolInfoDouble(symbol, SYMBOL_BID);

   MqlTradeRequest request = {};
   MqlTradeResult  result  = {};

   request.action    = TRADE_ACTION_DEAL;
   request.symbol    = symbol;
   request.volume    = volume;
   request.type      = closeType;
   request.price     = price;
   request.position  = ticket;
   request.deviation = InpSlippage;
   request.magic     = 202600;
   request.comment   = "NervaFX close";
   request.type_filling = ORDER_FILLING_FOK;

   if(!OrderSend(request, result) || (result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_PLACED))
   {
      outError = "Close failed: " + IntegerToString(result.retcode) + " " + result.comment;
      return false;
   }

   Print("NervaFX: Closed ticket ", ticket);
   return true;
}

//+------------------------------------------------------------------+
//| Modify stop loss on a position                                    |
//+------------------------------------------------------------------+
bool ModifySL(long ticket, double newSlPips, string &outError)
{
   if(!PositionSelectByTicket(ticket))
   {
      outError = "Position not found: " + IntegerToString(ticket);
      return false;
   }

   string symbol  = PositionGetString(POSITION_SYMBOL);
   double price   = PositionGetDouble(POSITION_PRICE_OPEN);
   double tp      = PositionGetDouble(POSITION_TP);
   long   posType = PositionGetInteger(POSITION_TYPE);
   double point   = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int    digits  = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   double sl;
   if(posType == POSITION_TYPE_BUY)
      sl = NormalizeDouble(price - newSlPips * 10 * point, digits);
   else
      sl = NormalizeDouble(price + newSlPips * 10 * point, digits);

   MqlTradeRequest request = {};
   MqlTradeResult  result  = {};

   request.action   = TRADE_ACTION_SLTP;
   request.symbol   = symbol;
   request.position = ticket;
   request.sl       = sl;
   request.tp       = tp;

   if(!OrderSend(request, result) || (result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_PLACED))
   {
      outError = "Modify SL failed: " + IntegerToString(result.retcode);
      return false;
   }

   Print("NervaFX: SL modified on ticket ", ticket, " to ", sl);
   return true;
}

//+------------------------------------------------------------------+
//| Partial close a position                                          |
//+------------------------------------------------------------------+
bool PartialClose(long ticket, double closePct, string &outError)
{
   if(!PositionSelectByTicket(ticket))
   {
      outError = "Position not found: " + IntegerToString(ticket);
      return false;
   }

   if(closePct <= 0 || closePct > 100)
   {
      outError = "Invalid close_pct: " + DoubleToString(closePct, 1);
      return false;
   }

   string symbol  = PositionGetString(POSITION_SYMBOL);
   double volume  = PositionGetDouble(POSITION_VOLUME);
   long   posType = PositionGetInteger(POSITION_TYPE);
   double closeVol = NormalizeDouble(volume * closePct / 100.0, 2);
   if(closeVol < 0.01) closeVol = 0.01;

   ENUM_ORDER_TYPE closeType = (posType == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (closeType == ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                                                 : SymbolInfoDouble(symbol, SYMBOL_BID);

   MqlTradeRequest request = {};
   MqlTradeResult  result  = {};

   request.action    = TRADE_ACTION_DEAL;
   request.symbol    = symbol;
   request.volume    = closeVol;
   request.type      = closeType;
   request.price     = price;
   request.position  = ticket;
   request.deviation = InpSlippage;
   request.magic     = 202600;
   request.comment   = "NervaFX partial";
   request.type_filling = ORDER_FILLING_FOK;

   if(!OrderSend(request, result) || (result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_PLACED))
   {
      outError = "Partial close failed: " + IntegerToString(result.retcode);
      return false;
   }

   Print("NervaFX: Partial close ", closePct, "% of ticket ", ticket, " (", closeVol, " lots)");
   return true;
}

//+------------------------------------------------------------------+
//| Acknowledge a command to the server                               |
//+------------------------------------------------------------------+
void AckCommand(const string cmdId, const string status, const string ticket, const string error)
{
   string url = InpServerUrl + "/api/ea-commands";
   string headers = "Content-Type: application/json\r\nX-EA-Key: " + InpApiKey + "\r\n";

   string body = "{";
   body += "\"command_id\":\"" + cmdId + "\",";
   body += "\"status\":\"" + status + "\"";
   if(StringLen(ticket) > 0)
      body += ",\"ticket\":\"" + ticket + "\"";
   if(StringLen(error) > 0)
      body += ",\"error\":\"" + error + "\"";
   body += "}";

   char postData[];
   char result[];
   string resultHeaders;

   StringToCharArray(body, postData, 0, StringLen(body), CP_UTF8);
   int res = WebRequest("POST", url, headers, InpRequestTimeout, postData, result, resultHeaders);

   if(res != 200)
      Print("NervaFX: Ack failed for command ", cmdId, " HTTP ", res);
}
//+------------------------------------------------------------------+
