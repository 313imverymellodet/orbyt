using System;
using System.Linq;
using UnityEngine;
#if UNITY_ANDROID && !UNITY_EDITOR
using System.Collections.Generic;
using GoogleMobileAds.Api;
using GoogleMobileAds.Ump.Api;
using UnityEngine.Purchasing;
#endif

// Google Play monetization: AdMob rewarded ads (behind Google's consent form for EEA/UK players) and a
// one-time "Remove Ads" purchase that works as an ad-free pass, so every reward is granted without a video.
// Only the Android player uses this; the browser build keeps its portal ads in WebBridge.
// Same file in every Mello Vibes game; only the per-game IDs below differ.
public static class Ads
{
    // ---- per-game settings (from AdMob → Apps → this app). Google's test IDs until the real ones are pasted in;
    // AndroidBuild.Release refuses to ship them. ----
    public const string AppId = "ca-app-pub-3940256099942544~3347511713";
    public const string RewardedUnitId = "ca-app-pub-3940256099942544/5224354917";
    public const string RemoveAdsProduct = "remove_ads";   // Play Console → Monetize → In-app products (non-consumable)

    public static bool UsingTestIds => AppId.Contains("3940256099942544") || RewardedUnitId.Contains("3940256099942544");

    public static bool Available { get; private set; }   // a rewarded video is loaded and can be shown now
    public static bool AdFree => PlayerPrefs.GetInt("ad_free", 0) == 1;
    public static bool CanBuyRemoveAds { get; private set; }   // the store is connected and the product is for sale
    public static string RemoveAdsPrice { get; private set; } = "";   // localized, e.g. "$2.99"
    public static bool PrivacyOptionsRequired { get; private set; }   // show a "Privacy" button (EEA/UK)
    public static bool Showing { get; private set; }   // a full-screen ad is up: don't treat the focus loss as a pause

    // Availability, price or ad-free state changed: refresh any buttons that depend on them.
    public static event Action Changed;

#if UNITY_ANDROID && !UNITY_EDITOR
    static bool started, adsStarted;
    static RewardedAd rewarded;
    static bool loading;
    static int retry;
    static StoreController store;
#endif

    // Call once at startup, after Mobile.Init().
    public static void Init()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        if (started) return;
        started = true;
        MobileAds.RaiseAdEventsOnUnityMainThread = true;
        InitStore();

        // Consent first: ads may only be requested once Google's UMP says so (it shows the form only where required).
        if (ConsentInformation.CanRequestAds()) StartAds();   // consent from an earlier session
        ConsentInformation.Update(new ConsentRequestParameters(), updateError =>
        {
            if (updateError != null) Debug.LogWarning("Consent update failed: " + updateError.Message);
            ConsentForm.LoadAndShowConsentFormIfRequired(formError =>
            {
                if (formError != null) Debug.LogWarning("Consent form failed: " + formError.Message);
                PrivacyOptionsRequired = ConsentInformation.PrivacyOptionsRequirementStatus == PrivacyOptionsRequirementStatus.Required;
                if (ConsentInformation.CanRequestAds()) StartAds();
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
#if UNITY_ANDROID && !UNITY_EDITOR
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
#if UNITY_ANDROID && !UNITY_EDITOR
        var p = store?.GetProductById(RemoveAdsProduct);
        if (p == null || AdFree) return;
        store.PurchaseProduct(p);
#endif
    }

    // Google's form for changing consent; required to be reachable when PrivacyOptionsRequired.
    public static void ShowPrivacyOptions()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        ConsentForm.ShowPrivacyOptionsForm(e =>
        {
            if (e != null) Debug.LogWarning("Privacy options failed: " + e.Message);
            if (ConsentInformation.CanRequestAds()) StartAds();
        });
#endif
    }

#if UNITY_ANDROID && !UNITY_EDITOR
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
