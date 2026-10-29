// Native iOS helpers for Mobile.cs and Ads.cs: haptics, the share sheet, alerts and the App Tracking Transparency prompt.
// Same file in every Mello Vibes game.
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AppTrackingTransparency/AppTrackingTransparency.h>
#import <UserNotifications/UserNotifications.h>

extern "C" {

// Unity's own C functions: declared inside extern "C" so they link to the unmangled symbols
UIViewController* UnityGetGLViewController();
void UnitySendMessage(const char* obj, const char* method, const char* msg);

// style: 0 light, 1 medium, 2 heavy
void MV_Haptic(int style)
{
    dispatch_async(dispatch_get_main_queue(), ^{
        UIImpactFeedbackStyle s = style <= 0 ? UIImpactFeedbackStyleLight : style == 1 ? UIImpactFeedbackStyleMedium : UIImpactFeedbackStyleHeavy;
        UIImpactFeedbackGenerator* g = [[UIImpactFeedbackGenerator alloc] initWithStyle:s];
        [g prepare];
        [g impactOccurred];
    });
}

void MV_Share(const char* text)
{
    NSString* t = [NSString stringWithUTF8String:text ? text : ""];
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController* root = UnityGetGLViewController();
        if (!root) return;
        UIActivityViewController* vc = [[UIActivityViewController alloc] initWithActivityItems:@[t] applicationActivities:nil];
        // iPad shows the sheet as a popover and needs an anchor
        vc.popoverPresentationController.sourceView = root.view;
        vc.popoverPresentationController.sourceRect = CGRectMake(root.view.bounds.size.width / 2, root.view.bounds.size.height, 1, 1);
        vc.popoverPresentationController.permittedArrowDirections = 0;
        [root presentViewController:vc animated:YES completion:nil];
    });
}

// A system alert with an OK button (store results: purchase failed, restored, nothing to restore).
void MV_Alert(const char* title, const char* message)
{
    NSString* t = [NSString stringWithUTF8String:title ? title : ""];
    NSString* m = [NSString stringWithUTF8String:message ? message : ""];
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController* root = UnityGetGLViewController();
        if (!root) return;
        while (root.presentedViewController) root = root.presentedViewController;
        UIAlertController* a = [UIAlertController alertControllerWithTitle:t message:m preferredStyle:UIAlertControllerStyleAlert];
        [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
        [root presentViewController:a animated:YES completion:nil];
    });
}

// Unity's default "Ambient" audio session goes quiet when the Silent switch is on. "Playback" plays anyway;
// MixWithOthers keeps the player's own music (Spotify, Apple Music) running underneath.
void MV_AudioPlayback()
{
    AVAudioSession* s = [AVAudioSession sharedInstance];
    [s setCategory:AVAudioSessionCategoryPlayback withOptions:AVAudioSessionCategoryOptionMixWithOthers error:nil];
    [s setActive:YES error:nil];
}

}

// Applies MV_AudioPlayback every time the app becomes active (launch, back from the home screen, after a call),
// after Unity has set up its own audio session. Works without any C# call.
@interface MVAudioSessionHook : NSObject
@end

@implementation MVAudioSessionHook
+ (void)load
{
    [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidBecomeActiveNotification object:nil queue:[NSOperationQueue mainQueue]
                                                  usingBlock:^(NSNotification* n) { MV_AudioPlayback(); }];
}
@end

extern "C" {

// Local notifications (reminders the game schedules itself; no server). iOS shows the permission prompt only once.
void MV_NotifyRequest()
{
    [[UNUserNotificationCenter currentNotificationCenter] requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                                                                        completionHandler:^(BOOL granted, NSError* error) {}];
}

// Replaces any pending reminder with the same id. Without permission iOS drops it silently.
void MV_NotifySchedule(const char* ident, const char* title, const char* body, int seconds)
{
    if (seconds < 1) return;
    UNMutableNotificationContent* c = [[UNMutableNotificationContent alloc] init];
    c.title = [NSString stringWithUTF8String:title ? title : ""];
    c.body = [NSString stringWithUTF8String:body ? body : ""];
    c.sound = [UNNotificationSound defaultSound];
    UNTimeIntervalNotificationTrigger* t = [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:seconds repeats:NO];
    UNNotificationRequest* r = [UNNotificationRequest requestWithIdentifier:[NSString stringWithUTF8String:ident ? ident : "mv"] content:c trigger:t];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:r withCompletionHandler:nil];
}

void MV_NotifyCancelAll()
{
    UNUserNotificationCenter* n = [UNUserNotificationCenter currentNotificationCenter];
    [n removeAllPendingNotificationRequests];
    [n removeAllDeliveredNotifications];
}

// 0 not determined, 1 restricted, 2 denied, 3 authorized (iOS < 14 has no prompt: reported as authorized)
int MV_TrackingStatus()
{
    if (@available(iOS 14, *)) return (int)[ATTrackingManager trackingAuthorizationStatus];
    return 3;
}

// Shows Apple's "Allow tracking?" prompt once, then calls receiver.OnTracking("<status>") on the Unity side.
void MV_RequestTracking(const char* receiver)
{
    NSString* r = [NSString stringWithUTF8String:receiver ? receiver : ""];
    if (@available(iOS 14, *))
    {
        dispatch_async(dispatch_get_main_queue(), ^{
            [ATTrackingManager requestTrackingAuthorizationWithCompletionHandler:^(ATTrackingManagerAuthorizationStatus status) {
                NSString* s = [NSString stringWithFormat:@"%d", (int)status];
                dispatch_async(dispatch_get_main_queue(), ^{ UnitySendMessage(r.UTF8String, "OnTracking", s.UTF8String); });
            }];
        });
    }
    else UnitySendMessage(r.UTF8String, "OnTracking", "3");
}

}
