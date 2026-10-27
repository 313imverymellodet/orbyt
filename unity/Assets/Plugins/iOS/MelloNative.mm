// Native iOS helpers for Mobile.cs and Ads.cs: haptics, the share sheet and the App Tracking Transparency prompt.
// Same file in every Mello Vibes game.
#import <UIKit/UIKit.h>
#import <AppTrackingTransparency/AppTrackingTransparency.h>

extern UIViewController* UnityGetGLViewController();
extern void UnitySendMessage(const char* obj, const char* method, const char* msg);

extern "C" {

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
