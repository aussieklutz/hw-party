/*
 * Hedgewars, a free turn based strategy game
 * Copyright (c) 2004-2015 Andrey Korotaev <unC0Rr@gmail.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; version 2 of the License
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 */

#ifndef HWFORM_H
#define HWFORM_H

#include <QElapsedTimer>
#include <QHash>
#include <QJsonObject>
#include <QMainWindow>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QPropertyAnimation>
#include <QStack>
#include <QTime>
#include <QTimer>
#include <QUrl>

#include "SDLInteraction.h"
#include "bgwidget.h"
#include "campaign.h"
#include "game.h"
#include "hwform_ui.h"
#include "netserver.h"
#include "partyhostcore.h"

#ifdef __APPLE__
#include "InstallController.h"
#endif

class HWGame;
class HWTeam;
class HWNamegen;
class HWNewNet;
class PartyClient;
class GameUIConfig;
class HWNetRegisterServer;
class QCloseEvent;
class GameSchemeModel;
class QSettings;
class QSignalMapper;

extern bool frontendEffects;
extern bool demoIsPresent;
extern QString playerHash;

class HWForm : public QMainWindow {
  Q_OBJECT

 public:
  HWForm(QWidget *parent = 0, const QString &styleSheet = QLatin1String(""));
  Ui_HWForm ui;
  static GameUIConfig *config;
  void exit();
  void setButtonDescription(QString desc);
  void backDescription();
  void GoToVideos();
  void GoToTraining();

  void NetConnectQuick(const QString &host, quint16 port);
  void PlayDemoQuick(const QString &demofilename);

 public Q_SLOTS:
  void GoToSaves();
  void GoToDemos();
  void GoToNet();
  void GoToHelp();
  void GoToEditWeapons();
  void GoToNewWeapons();
  void GoToWeapons(int index);
  void GoToScheme(int index);
  void GoToEditScheme();
  void GoToNewScheme();
  void GoToPage(int id);
  void GoBack();
  void OpenSnapshotFolder();
  QString getDemoArguments();
  void AssociateFiles();
  void btnExitPressed();
  void IntermediateSetup();
  void NewTeam();
  void EditTeam(const QString &teamName);
  void AfterTeamEdit();
  void DeleteTeam(const QString &teamName);
  void DeleteScheme();
  void DeleteWeaponSet();
  void SimpleGame();
  void PlayDemo();
  void startTraining(const QString &, const QString &);
  void StartCampaign();
  void NetConnect();
  void NetConnectServer(const QString &host, quint16 port, bool useTls);
  void NetConnectOfficialServer();
  void NetStartServer();
  void PartyCreate();
  void PartyStart();
  void PartyRoomCreated(const QString &code);
  void updatePartySlots();
  void updateDynamicCpu();
  HWTeam makeCpuPlaceholder(int n) const;
  void PartyTeamRegistered(const QString &sid, const QJsonObject &config,
                           int seat);
  void PartyMemberJoined(const QString &sid);
  void PartyMemberLeft(const QString &sid);
  void PartyError(const QString &message);
  void PartyGameEnded();
  void PartyTraitorSwapped(const QString &fromTeam);
  void PartyTurnTeamChanged(const QString &teamName, int hogIndex);
  void PartyInput(const QString &sid, const QString &action);
  void PartyCursor(const QString &sid, int x, int y);
  void PartyPut(const QString &sid, int x, int y);
  void sendPartyXY(char cmd, int x, int y);
  void sendPartyCommand(const QString &command);
  void releasePartyKeys();
  void NetRedirected(quint16 port);
  void NetDisconnect();
  void NetConnected();
  void NetError(const QString &errmsg);
  void NetWarning(const QString &wrnmsg);
  void NetGameEnter();
  void NetPassword(const QString &nick);
  void NetNickRegistered(const QString &nick);
  void NetNickNotRegistered(const QString &nick);
  void NetNickTaken(const QString &nick);
  void NetAuthFailed();
  void askRoomPassword();
  bool RetryDialog(const QString &title, const QString &label);
  void NetTeamAccepted(const QString &team);
  void AddNetTeam(const HWTeam &team);
  void RemoveNetTeam(const HWTeam &team);
  void StartMPGame();
  void GameStateChanged(GameState gameState);
  void DemoPresenceChanged(bool hasDemo);
  void ForcedDisconnect(const QString &reason);
  void ShowFatalErrorMessage(const QString &);
  void GetRecord(RecordType type, const QByteArray &record);
  void CreateNetGame();
  void PlayOfficialServerDemo();
  void UpdateWeapons();
  void DeleteWeapons(const QString &weaponsName);
  void AddWeapons(const QString &weaponsName, const QString &ammo);
  void EditWeapons(const QString &oldWeaponsName, const QString &newWeaponsName,
                   const QString &ammo);
  void onFrontendFullscreen(bool value);
  void onFrontendEffects(bool value);
  void onFrontendSoundsToggled(bool value);
  void Music(bool checked);
  void UpdateCampaignPage(int index);
  void UpdateCampaignPageTeam(int index);
  void UpdateCampaignPageProgress(int index);
  void UpdateCampaignPageMission(int index);
  void UpdateTrainingPageTeam(int index);
  void InitCampaignPage();
  void RestoreSingleplayerTeamSelection();
  void showFeedbackDialog();
  void showFeedbackDialogNetChecked();

  void NetGameChangeStatus(bool isMaster);
  void NetGameMaster();
  void NetGameSlave();

  void AsyncNetServerStart();
  void NetLeftRoom(const QString &reason);
  void selectFirstNetScheme();

  void saveDemoWithCustomName();
  void openRegistrationPage();

  void startGame();
  void restartGame();

  void FromNetProxySlot(const QByteArray &);

 private:
  void _NetConnect(const QString &hostName, quint16 port, bool useTls,
                   const QString &nick);
  int AskForNickAndPwd(void);
  void UpdateTeamsLists();
  void CreateGame(GameCFGWidget *gamecfg, TeamSelWidget *pTeamSelWidget,
                  const QString &ammo);
  void closeEvent(QCloseEvent *event);
  void CustomizePalettes();
  void resizeEvent(QResizeEvent *event);
  QString stringifyPageId(quint32 id);
  // void keyReleaseEvent(QKeyEvent *event);

  enum PageIDs {
    ID_PAGE_SETUP_TEAM,
    ID_PAGE_SETUP,
    ID_PAGE_MULTIPLAYER,
    ID_PAGE_DEMOS,
    ID_PAGE_NET,
    ID_PAGE_NETGAME,
    ID_PAGE_INFO,
    ID_PAGE_MAIN,
    ID_PAGE_GAMESTATS,
    ID_PAGE_SINGLEPLAYER,
    ID_PAGE_TRAINING,
    ID_PAGE_SELECTWEAPON,
    ID_PAGE_NETSERVER,
    ID_PAGE_PARTY,
    ID_PAGE_INGAME,
    ID_PAGE_ROOMSLIST,
    ID_PAGE_CONNECTING,
    ID_PAGE_SCHEME,
    ID_PAGE_ADMIN,
    ID_PAGE_CAMPAIGN,
    ID_PAGE_DRAWMAP,
    ID_PAGE_DATADOWNLOAD,
    ID_PAGE_VIDEOS,
    MAX_PAGE
  };
  QPointer<HWGame> game;
  QPointer<HWNetServer> pnetserver;
  QPointer<HWNetRegisterServer> pRegisterServer;
  QPointer<HWTeam> editedTeam;
  QPointer<HWNewNet> hwnet;
  QPointer<PartyClient> partyClient;
  QHash<QString, QString> m_partyTeamToSid;
  QString m_partyActiveSid;
  QString m_partyMode;
  int m_partySlots;
  int m_partyCpuTier;
  QList<HWTeam> m_partyPlaceholders;
  QStringList m_partyAdopted;
  QStringList m_partyGone;
  int m_partyCpuCounter;

  // Team and imposter lobbies: the lobby, the imposters and the turn routing
  // live in PartyHostCore (UI-free, tested on its own); HWForm applies what it
  // says.
  PartyHostCore *m_partyCore = nullptr;
  void ensurePartyCore();
  bool isPartySeatMode() const;
  int partyMaxPlayers() const;
  // AFK turn countdown (a sleeping phone skips its turn): the host
  // probes /alive at turn starts and pauses/skips on silence
  void PartyAliveChecked(const QString &sid, bool alive);
  void PartyAfkTick();
  void cancelPartyAfk();
  void startPartyAfkWatch(const QString &teamName, const QString &sid);
  void sendPartyRaw(const QString &command);
  QString m_partyAfkSid;
  QString m_partyAfkTeam;
  int m_partyAfkLeft = 0;
  bool m_partyEnginePaused = false;
  QTimer *m_partyAfkTimer = nullptr;
  HWNamegen *namegen;
  GameSchemeModel *gameSchemeModel;
  QStack<int> PagesStack;
  QString previousCampaignName;
  QString previousTeamName;
  QList<MissionInfo> campaignMissionInfo;
  QElapsedTimer eggTimer;
  QPointer<BGWidget> wBackground;
  QPointer<QSignalMapper> pageSwitchMapper;
  QByteArray m_lastDemo;

  QPropertyAnimation *animationNewSlide;
  QPropertyAnimation *animationOldSlide;
  QPropertyAnimation *animationNewOpacity;
  QPropertyAnimation *animationOldOpacity;

#ifdef __APPLE__
  InstallController *panel;
#endif

  void OnPageShown(quint8 id, quint8 lastid = 0);
};

#endif
