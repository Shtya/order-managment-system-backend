
export const SEED_DATA = {
    productCategories: [
        {
            name: 'العناية الشخصية',
            slug: 'personal-care',
            image: 'uploads/seed/category-personal-care.jpg'
        },
        {
            name: 'الرياضة واللياقة',
            slug: 'sports-fitness',
            image: 'uploads/seed/category-sports.jpg'
        },
        {
            name: 'الشنط والسفر',
            slug: 'bags-travel',
            image: 'uploads/seed/category-bags.jpg'
        }
    ],
    supplierCategories: [
        {
            name: 'موردو إلكترونيات',
            description: 'شركات وموردين للأجهزة الإلكترونية والإكسسوارات'
        },
        {
            name: 'موردو ملابس وأزياء',
            description: 'موردين للملابس والمنتجات المتعلقة بالأزياء'
        },
        {
            name: 'موردو مستلزمات منزلية',
            description: 'موردين للأدوات والمستلزمات المنزلية المختلفة'
        }
    ],

    supplier: {
        name: 'شركة النور للتوريدات',
        phone: '1000000000',
        phoneCountry: 'EG',
        address: 'القاهرة، مصر',
        description: 'شركة توريد متعددة الأقسام توفر منتجات متنوعة للتجار والمتاجر الإلكترونية'
    },
    products: [
        {
            name: 'ساعة ذكية رياضية بشاشة HD',
            type: 'single',
            wholesalePrice: 450,
            salePrice: 899,
            lowestPrice: 750,
            storageRack: 'A1',
            slug: 'smart-watch-hd',
            sku: 'SKU-SW001',
            mainImage: 'uploads/seed/product-smart-watch.jpg',
            images: [
                { url: 'uploads/seed/product-smart-watch-1.jpg' },
                { url: 'uploads/seed/product-smart-watch-2.jpg' }
            ],

            description: 'ساعة ذكية رياضية تدعم قياس نبضات القلب والخطوات والإشعارات.',
            upsellingEnabled: true,
            upsellingProducts: [],
            skipRemoteCheck: true
        },

        {
            name: 'حقيبة ظهر مقاومة للماء للابتوب',
            type: 'single',
            wholesalePrice: 320,
            salePrice: 699,
            lowestPrice: 550,
            storageRack: 'B2',
            slug: 'waterproof-laptop-backpack',
            sku: 'SKU-BAG002',
            mainImage: 'uploads/seed/product-backpack-3.jpg',
            images: [
                { url: 'uploads/seed/product-backpack-1.jpg' },
                { url: 'uploads/seed/product-backpack-2.jpg' }
            ],
            description: 'شنطة ظهر عملية مناسبة للعمل والسفر وتحمل لابتوب حتى 15.6 بوصة.',
            upsellingEnabled: false,
            upsellingProducts: [],
            skipRemoteCheck: true
        },
        {
            name: 'كرسي مكتب مريح قابل للتعديل',
            type: 'variable',
            wholesalePrice: 1200,
            salePrice: 1899,
            lowestPrice: 1650,
            storageRack: 'E2',
            slug: 'office-chair-adjustable',
            sku: 'SKU-CHR005',
            mainImage: 'uploads/seed/product-chair.jpg',
            images: [
                { url: 'uploads/seed/product-chair-1.jpg' },
                { url: 'uploads/seed/product-chair-2.jpg' }
            ],
            description: 'كرسي مكتب مريح بظهر داعم وارتفاع قابل للتعديل.',
            upsellingEnabled: false,
            upsellingProducts: [],
            skipRemoteCheck: true,
            combinations: [
                {
                    key: "اللون=اسود|الخامة=جلد",
                    attributes: {
                        "اللون": "اسود",
                        "الخامة": "جلد"
                    },
                    sku: "CHAIR-BLACK-LEATHER",
                    stockOnHand: 0,
                    price: 1899,
                    isActive: true,
                    unitCost: 1200
                },
                {
                    key: "اللون=رمادي|الخامة=قماش",
                    attributes: {
                        "اللون": "رمادي",
                        "الخامة": "قماش"
                    },
                    sku: "CHAIR-GRAY-FABRIC",
                    stockOnHand: 0,
                    price: 1799,
                    isActive: true,
                    unitCost: 1100
                },
                {
                    key: "اللون=رمادي|الخامة=جلد",
                    attributes: {
                        "اللون": "رمادي",
                        "الخامة": "جلد"
                    },
                    sku: "CHAIR-GRAY-LEATHER",
                    stockOnHand: 0,
                    price: 1949,
                    isActive: true,
                    unitCost: 1250
                },
                {
                    key: "اللون=اسود|الخامة=قماش",
                    attributes: {
                        "اللون": "اسود",
                        "الخامة": "قماش"
                    },
                    sku: "CHAIR-BLACK-FABRIC",
                    stockOnHand: 0,
                    price: 1749,
                    isActive: true,
                    unitCost: 1050
                }
            ]
        }
    ]
};