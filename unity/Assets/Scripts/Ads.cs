#if (UNITY_ANDROID || UNITY_IOS) && !UNITY_EDITOR
#define MV_NATIVE_ADS
#endif
using System;
using System.Linq;
using UnityEngine;
#if MV_NATIVE_ADS
using System.Collections.Generic;
using GoogleMobileAds.Api;
using GoogleMobileAds.Ump.Api;
using UnityEngine.Purchasing;
#endif

// Google Play / App Store monetization: AdMob rewarded ads (behind Google's consent form for EEA/UK players and,
// on iOS, Apple's tracking prompt) and a one-time "Remove Ads" purchase that works as an ad-free pass, so every
// reward is granted without a video. Only the phone builds use this; the browser build keeps its portal ads in WebBridge.
// Same file in every Mello Vibes game; only the per-game IDs below differ.
public static class Ads
{
    // ---- per-game settings (from AdMob → Apps). Google's test IDs until the real ones are pasted in;
    // AndroidBuild.Release and IosBuild refuse to ship them unless -testAds. ----
    public const string AndroidAppId = "ca-app-pub-3940256099942544~3347511713";
    public const string AndroidRewardedId = "ca-app-pub-3940256099942544/5224354917";
    public const string IosAppId = "ca-app-pub-3940256099942544~1458002511";
    public const string IosRewardedId = "ca-app-pub-3940256099942544/1712485313";
    public const string RemoveAdsProduct = "remove_ads";   // Play Console and App Store Connect: non-consumable

    // Text in Apple's "Allow tracking?" prompt (Info.plist NSUserTrackingUsageDescription).
    public const string TrackingReason = "This lets us show you ads that are more relevant to you. You can say no and still play with every feature.";

    const string TestPublisher = "3940256099942544";
    public static bool AndroidUsesTestIds => AndroidAppId.Contains(TestPublisher) || AndroidRewardedId.Contains(TestPublisher);
    public static bool IosUsesTestIds => IosAppId.Contains(TestPublisher) || IosRewardedId.Contains(TestPublisher);
#if UNITY_IOS
    static string RewardedUnitId => IosRewardedId;
#else
    static string RewardedUnitId => AndroidRewardedId;
#endif

    public static bool Available { get; private set; }   // a rewarded video is loaded and can be shown now
    public static bool AdFree => PlayerPrefs.GetInt("ad_free", 0) == 1;
    public static bool CanBuyRemoveAds { get; private set; }   // the store is connected and the product is for sale
    public static string RemoveAdsPrice { get; private set; } = "";   // localized, e.g. "$2.99"
    public static bool PrivacyOptionsRequired { get; private set; }   // show a "Privacy" button (EEA/UK)
    public static bool Showing { get; private set; }   // a full-screen ad is up: don't treat the focus loss as a pause
    // Apple requires a visible "Restore Purchases" button for non-consumables; Google Play restores on its own.
    public static bool ShowRestoreButton => Application.platform == RuntimePlatform.IPhonePlayer && !AdFree;

    // Availability, price or ad-free state changed: refresh any buttons that depend on them.
    public static event Action Changed;

#if MV_NATIVE_ADS
    static bool started, adsStarted;
    static RewardedAd rewarded;
    static bool loading;
    static int retry;
    static StoreController store;
#endif
#if UNITY_IOS && !UNITY_EDITOR
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern int MV_TrackingStatus();
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_RequestTracking(string receiver);

    // Receives the tracking prompt's answer from MelloNative.mm through UnitySendMessage.
    class TrackingReceiver : MonoBehaviour
    {
        public void OnTracking(string status) { StartAds(); Destroy(gameObject); }
    }
#endif

    // Call once at startup, after Mobile.Init().
    public static void Init()
    {
#if MV_NATIVE_ADS
        if (started) return;
        started = true;
        MobileAds.RaiseAdEventsOnUnityMainThread = true;
        InitStore();

        // Consent first: ads may only be requested once Google's UMP says so (it shows the form only where required).
        if (ConsentInformation.CanRequestAds()) AfterConsent();   // consent from an earlier session
        ConsentInformation.Update(new ConsentRequestParameters(), updateError =>
        {
            if (updateError != null) Debug.LogWarning("Consent update failed: " + updateError.Message);
            ConsentForm.LoadAndShowConsentFormIfRequired(formError =>
            {
                if (formError != null) Debug.LogWarning("Consent form failed: " + formError.Message);
                PrivacyOptionsRequired = ConsentInformation.PrivacyOptionsRequirementStatus == PrivacyOptionsRequirementStatus.Required;
                if (ConsentInformation.CanRequestAds()) AfterConsent();
                Changed?.Invoke();
            });
        });
#endif
    }

    // Shows a rewarded video, then calls done(true) after it closes if the player earned the reward.
    // Ad-free players get done(true) straight away.
    public static void ShowRewarded(Action<bool> done)
    {
        if (AdFree) { done?.Invoke(true); return; }
#if MV_NATIVE_ADS
        if (rewarded == null || !rewarded.CanShowAd()) { done?.Invoke(false); Load(); return; }
        var ad = rewarded;
        rewarded = null;
        Available = false;
        bool earned = false, finished = false;
        void Finish()
        {
            if (finished) return;
            finished = true;
            Showing = false;
            AudioListener.pause = false;
            ad.Destroy();
            Load();
            Changed?.Invoke();
            done?.Invoke(earned);
        }
        ad.OnAdFullScreenContentClosed += Finish;
        ad.OnAdFullScreenContentFailed += e => { Debug.LogWarning("Rewarded ad failed to show: " + e.GetMessage()); Finish(); };
        Showing = true;
        AudioListener.pause = true;
        ad.Show(reward => earned = true);
#else
        done?.Invoke(false);
#endif
    }

    public static void BuyRemoveAds()
    {
#if MV_NATIVE_ADS
        var p = store?.GetProductById(RemoveAdsProduct);
        if (p == null || AdFree) return;
        store.PurchaseProduct(p);
#endif
    }

    // App Store: asks Apple for earlier purchases (may prompt for the Apple ID password).
    public static void RestorePurchases()
    {
#if MV_NATIVE_ADS
        store?.RestoreTransactions((ok, error) =>
        {
            if (!ok) Debug.LogWarning("Restore failed: " + error);
            store.FetchPurchases();
        });
#endif
    }

    // Google's form for changing consent; required to be reachable when PrivacyOptionsRequired.
    public static void ShowPrivacyOptions()
    {
#if MV_NATIVE_ADS
        ConsentForm.ShowPrivacyOptionsForm(e =>
        {
            if (e != null) Debug.LogWarning("Privacy options failed: " + e.Message);
            if (ConsentInformation.CanRequestAds()) StartAds();
        });
#endif
    }

#if MV_NATIVE_ADS
    // iOS: Apple's tracking prompt comes after Google's consent form, then ads start either way
    // (a "no" just means non-personalized ads).
    static void AfterConsent()
    {
#if UNITY_IOS && !UNITY_EDITOR
        if (MV_TrackingStatus() == 0)
        {
            var go = new GameObject("MelloAdsTracking");
            UnityEngine.Object.DontDestroyOnLoad(go);
            go.AddComponent<TrackingReceiver>();
            MV_RequestTracking(go.name);
            return;
        }
#endif
        StartAds();
    }

    static void StartAds()
    {
        if (adsStarted) return;
        adsStarted = true;
        MobileAds.Initialize(_ => Load());
    }

    static void Load()
    {
        if (!adsStarted || AdFree || loading || rewarded != null) return;
        loading = true;
        RewardedAd.Load(RewardedUnitId, new AdRequest(), async (ad, error) =>
        {
            loading = false;
            if (error != null || ad == null)
            {
                Debug.LogWarning("Rewarded ad failed to load: " + error?.GetMessage());
                retry = Math.Min(retry + 1, 6);
                await System.Threading.Tasks.Task.Delay(1000 * (1 << retry));   // 2s, 4s ... 64s
                Load();
                return;
            }
            retry = 0;
            rewarded = ad;
            Available = true;
            Changed?.Invoke();
        });
    }

    static async void InitStore()
    {
        try
        {
            store = UnityIAPServices.StoreController();
            store.OnProductsFetched += products =>
            {
                var p = products.FirstOrDefault(x => x.definition.id == RemoveAdsProduct);
                CanBuyRemoveAds = p != null && p.availableToPurchase;
                RemoveAdsPrice = p?.metadata.localizedPriceString ?? "";
                store.FetchPurchases();   // restores the pass after a reinstall or on a new phone
                Changed?.Invoke();
            };
            store.OnProductsFetchFailed += f => Debug.LogWarning("IAP products unavailable: " + f.FailureReason);
            store.OnPurchasesFetched += orders =>
            {
                if (orders.ConfirmedOrders.Any(Owns)) Grant();
                foreach (var o in orders.PendingOrders) store.ConfirmPurchase(o);
            };
            store.OnPurchasePending += order => { if (Owns(order)) Grant(); store.ConfirmPurchase(order); };
            store.OnPurchaseFailed += f => Debug.LogWarning("Purchase failed: " + f.FailureReason + " " + f.Details);
            await store.Connect();
            store.FetchProducts(new List<ProductDefinition> { new ProductDefinition(RemoveAdsProduct, ProductType.NonConsumable) });
        }
        catch (Exception e) { Debug.LogWarning("IAP unavailable: " + e.Message); }
    }

    static bool Owns(Order o) => o.CartOrdered.Items().Any(i => i.Product.definition.id == RemoveAdsProduct);

    static void Grant()
    {
        if (AdFree) return;
        PlayerPrefs.SetInt("ad_free", 1);
        PlayerPrefs.Save();
        rewarded?.Destroy(); rewarded = null; Available = false;
        Changed?.Invoke();
    }
#endif
}
